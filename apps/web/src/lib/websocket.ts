import { userIdFromPublicKey, type DerivedKeys } from "@messages/crypto";
import { MAX_CONVERSATIONS } from "@messages/shared";
import {
  API_URL,
  type FetchLike,
  loginToServer,
  resolveApiUrl,
} from "./api.js";
import type { ServerSession } from "../session.js";

export type SocketState = "connected" | "connecting" | "offline";
export function resolveWebSocketUrl(apiUrl = API_URL): string {
  return `${resolveApiUrl(apiUrl).replace(/^http/u, "ws")}/ws`;
}
export type OutgoingFrame = {
  type: "send";
  clientMsgId: string;
  to: string;
  ciphertext: string;
  senderCopy: string;
};
export type IncomingFrame = Record<string, unknown> & { type: string };
export const HEARTBEAT_IDLE_MS = 25_000;
export const HEARTBEAT_TIMEOUT_MS = 10_000;
export const HEARTBEAT_MIN_INTERVAL_MS = 5_000;
type SocketLike = Pick<WebSocket, "send" | "close" | "addEventListener">;
type SocketFactory = (url: string) => SocketLike;
type PendingFrame = {
  frame: OutgoingFrame;
  timer: ReturnType<typeof setTimeout> | null;
};

export class ChatConnection {
  private socket: SocketLike | null = null;
  private active = false;
  private authenticated = false;
  private retry = 0;
  private unauthorizedRetries = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly outbox = new Map<string, PendingFrame>();
  private readonly pendingAck: string[] = [];
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private state: SocketState = "offline";
  private readonly seen = new Set<string>();
  private presencePeerIds: string[] = [];
  private presenceConfigured = false;
  private sendingPaused = false;
  private session: ServerSession | null;
  private sessionRequest: Promise<ServerSession> | null = null;
  private receiveQueue: Promise<void> = Promise.resolve();
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private heartbeatIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPingAt = 0;
  private readonly heartbeatDocument:
    | Pick<
        Document,
        "visibilityState" | "addEventListener" | "removeEventListener"
      >
    | undefined;
  private readonly heartbeatWindow:
    Pick<Window, "addEventListener" | "removeEventListener"> | undefined;

  constructor(
    private readonly keys: DerivedKeys,
    session: ServerSession | null,
    private readonly handlers: {
      onState(state: SocketState): void;
      onFrame(frame: IncomingFrame): void | Promise<void>;
      onSend?(clientMsgId: string): void;
      onSent?(clientMsgId: string): void;
      onSendTimeout?(clientMsgId: string): void;
    },
    private readonly deps: {
      fetcher?: FetchLike;
      login?: (
        keys: DerivedKeys,
        fetcher?: FetchLike,
      ) => Promise<ServerSession>;
      socketFactory?: SocketFactory;
      random?: () => number;
      setTimer?: typeof setTimeout;
      clearTimer?: typeof clearTimeout;
      sendTimeoutMs?: number;
      heartbeatIdleMs?: number;
      heartbeatTimeoutMs?: number;
      heartbeatMinIntervalMs?: number;
      document?: Pick<
        Document,
        "visibilityState" | "addEventListener" | "removeEventListener"
      >;
      window?: Pick<Window, "addEventListener" | "removeEventListener">;
    } = {},
  ) {
    const nativeSetTimer = globalThis.setTimeout;
    const nativeClearTimer = globalThis.clearTimeout;
    this.setTimer = deps.setTimer ?? nativeSetTimer;
    this.clearTimer = deps.clearTimer ?? nativeClearTimer;
    this.heartbeatDocument =
      deps.document ?? (typeof document === "undefined" ? undefined : document);
    this.heartbeatWindow =
      deps.window ?? (typeof window === "undefined" ? undefined : window);
    this.session =
      session?.userId === userIdFromPublicKey(keys.identity.publicKey)
        ? session
        : null;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    void this.connect();
  }

  stop(): void {
    this.active = false;
    if (this.timer) callClearTimer(this.clearTimer, this.timer);
    if (this.ackTimer) callClearTimer(this.clearTimer, this.ackTimer);
    this.timer = null;
    this.ackTimer = null;
    this.authenticated = false;
    this.stopHeartbeat();
    for (const pending of this.outbox.values()) this.clearPendingTimer(pending);
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "logout");
    this.setState("offline");
  }

  currentToken(): string | null {
    return this.session?.token ?? null;
  }

  async ensureSession(): Promise<ServerSession> {
    if (this.session && Date.parse(this.session.expiresAt) > Date.now())
      return this.session;
    return this.refreshSession();
  }

  async refreshSession(): Promise<ServerSession> {
    if (this.sessionRequest) return this.sessionRequest;
    const login = this.deps.login ?? loginToServer;
    this.sessionRequest = login(this.keys, this.deps.fetcher)
      .then((session) => {
        this.session = session;
        return session;
      })
      .finally(() => {
        this.sessionRequest = null;
      });
    return this.sessionRequest;
  }

  send(frame: OutgoingFrame): void {
    if (!this.outbox.has(frame.clientMsgId))
      this.outbox.set(frame.clientMsgId, { frame, timer: null });
    if (this.authenticated && !this.sendingPaused)
      this.sendPending(this.outbox.get(frame.clientMsgId)!);
  }

  setSendingPaused(paused: boolean): void {
    this.sendingPaused = paused;
    if (paused || !this.authenticated) return;
    for (const pending of this.outbox.values()) this.sendPending(pending);
  }

  clearPeer(peerId: string): void {
    for (const [clientMsgId, pending] of this.outbox) {
      if (pending.frame.to !== peerId) continue;
      this.clearPendingTimer(pending);
      this.outbox.delete(clientMsgId);
    }
  }

  sendRead(peerId: string, upToSeq: string): void {
    if (this.authenticated && this.socket && this.active)
      this.socket.send(JSON.stringify({ type: "read", peerId, upToSeq }));
  }

  setPresencePeers(peerIds: string[]): void {
    this.presenceConfigured = true;
    this.presencePeerIds = [...new Set(peerIds)].slice(0, MAX_CONVERSATIONS);
    if (this.authenticated) this.sendPresenceSubscriptions();
  }

  private sendPresenceSubscriptions(): void {
    if (
      !this.presenceConfigured ||
      !this.authenticated ||
      !this.socket ||
      !this.active
    )
      return;
    this.socket.send(
      JSON.stringify({
        type: "presence_subscribe",
        peerIds: this.presencePeerIds,
      }),
    );
  }

  retryMessage(frame: OutgoingFrame): void {
    const pending = this.outbox.get(frame.clientMsgId) ?? {
      frame,
      timer: null,
    };
    pending.frame = frame;
    this.outbox.set(frame.clientMsgId, pending);
    if (this.authenticated) this.sendPending(pending);
  }

  hasSeen(id: string): boolean {
    return this.seen.has(id);
  }
  markSeen(id: string): void {
    this.seen.add(id);
  }

  private setState(state: SocketState): void {
    if (this.state !== state) {
      this.state = state;
      this.handlers.onState(state);
    }
  }

  private url(): string {
    return resolveWebSocketUrl();
  }

  private async connect(): Promise<void> {
    if (!this.active) return;
    this.setState("connecting");
    try {
      await this.ensureSession();
      if (!this.active) return;
      const socket = (this.deps.socketFactory ?? ((url) => new WebSocket(url)))(
        this.url(),
      );
      this.socket = socket;
      socket.addEventListener("open", () => {
        if (this.active && this.socket === socket)
          socket.send(
            JSON.stringify({ type: "auth", token: this.currentToken() }),
          );
      });
      socket.addEventListener("message", (event) => {
        if (this.active && this.socket === socket) {
          this.heartbeatFrameReceived();
          this.receiveQueue = this.receiveQueue
            .then(() => this.receive(event.data))
            .catch(() => undefined);
        }
      });
      socket.addEventListener("close", (event) => {
        if (this.socket !== socket) return;
        this.stopHeartbeat();
        this.socket = null;
        this.authenticated = false;
        if (!this.active) return;
        if (event.code === 4401) {
          const immediate = this.unauthorizedRetries === 0;
          this.unauthorizedRetries++;
          this.schedule(immediate ? 0 : undefined, true);
          return;
        }
        if (event.code === 4429) {
          this.schedule(30_000);
          return;
        }
        this.schedule();
      });
      socket.addEventListener("error", () => {
        if (this.active) this.setState("offline");
      });
    } catch {
      this.setState("offline");
      this.schedule();
    }
  }

  private async receive(raw: unknown): Promise<void> {
    let frame: IncomingFrame;
    try {
      frame = JSON.parse(String(raw)) as IncomingFrame;
    } catch {
      return;
    }
    if (frame.type === "auth_ok") {
      this.authenticated = true;
      this.retry = 0;
      this.unauthorizedRetries = 0;
      this.setState("connected");
      this.startHeartbeat();
      this.sendPresenceSubscriptions();
      if (!this.sendingPaused)
        for (const pending of this.outbox.values()) this.sendPending(pending);
      return;
    }
    if (frame.type === "pong") return;
    if (frame.type === "message" && typeof frame.id === "string") {
      if (!this.seen.has(frame.id)) {
        this.seen.add(frame.id);
        try {
          await this.handlers.onFrame(frame);
        } catch {
          /* Ack even when processing fails */
        }
      }
      this.enqueueAck(frame.id);
      return;
    }
    if (
      (frame.type === "sent" ||
        frame.type === "delivered" ||
        frame.type === "error") &&
      typeof frame.clientMsgId === "string"
    ) {
      if (frame.type === "sent") this.handlers.onSent?.(frame.clientMsgId);
      const pending = this.outbox.get(frame.clientMsgId);
      if (pending) {
        this.clearPendingTimer(pending);
        this.outbox.delete(frame.clientMsgId);
      }
    }
    if (frame.type === "error" && typeof frame.clientMsgId !== "string") {
      for (const [clientMsgId, pending] of this.outbox) {
        this.clearPendingTimer(pending);
        this.handlers.onSendTimeout?.(clientMsgId);
      }
    }
    await this.handlers.onFrame(frame);
  }

  private sendPending(pending: PendingFrame): void {
    if (
      !this.authenticated ||
      this.sendingPaused ||
      !this.socket ||
      !this.active
    )
      return;
    this.clearPendingTimer(pending);
    try {
      this.socket.send(JSON.stringify(pending.frame));
    } catch (error) {
      this.handlers.onSendTimeout?.(pending.frame.clientMsgId);
      throw error;
    }
    this.handlers.onSend?.(pending.frame.clientMsgId);
    pending.timer = callSetTimer(
      this.setTimer,
      () => {
        pending.timer = null;
        if (this.outbox.get(pending.frame.clientMsgId) === pending)
          this.handlers.onSendTimeout?.(pending.frame.clientMsgId);
      },
      this.deps.sendTimeoutMs ?? 15_000,
    );
  }

  private clearPendingTimer(pending: PendingFrame): void {
    if (pending.timer) callClearTimer(this.clearTimer, pending.timer);
    pending.timer = null;
  }

  private enqueueAck(id: string): void {
    this.pendingAck.push(id);
    if (this.pendingAck.length >= 200) {
      this.flushAcks();
      return;
    }
    if (!this.ackTimer)
      this.ackTimer = callSetTimer(
        this.setTimer,
        () => {
          this.ackTimer = null;
          this.flushAcks();
        },
        50,
      );
  }

  private flushAcks(): void {
    if (this.ackTimer) callClearTimer(this.clearTimer, this.ackTimer);
    this.ackTimer = null;
    while (this.pendingAck.length) {
      const ids = this.pendingAck.splice(0, 200);
      if (this.authenticated && this.socket)
        this.socket.send(JSON.stringify({ type: "ack", ids }));
    }
  }

  private schedule(delay?: number, renew = false): void {
    if (!this.active) return;
    this.setState("offline");
    const base = delay ?? Math.min(30_000, 1_000 * 2 ** this.retry++);
    const jittered =
      delay === undefined
        ? Math.floor(
            base * (0.8 + (this.deps.random?.() ?? Math.random()) * 0.4),
          )
        : base;
    this.timer = callSetTimer(
      this.setTimer,
      () => {
        this.timer = null;
        void (async () => {
          if (!this.active) return;
          if (renew) {
            try {
              await this.refreshSession();
            } catch {
              this.schedule();
              return;
            }
          }
          await this.connect();
        })();
      },
      jittered,
    );
  }

  private isHeartbeatVisible(): boolean {
    return this.heartbeatDocument?.visibilityState === "visible";
  }

  private startHeartbeat(): void {
    if (!this.authenticated || !this.active || !this.socket) return;
    this.stopHeartbeat();
    if (typeof this.heartbeatDocument?.addEventListener === "function")
      this.heartbeatDocument.addEventListener(
        "visibilitychange",
        this.onVisibilityChange,
      );
    if (typeof this.heartbeatWindow?.addEventListener === "function")
      this.heartbeatWindow.addEventListener("online", this.onOnline);
    if (this.isHeartbeatVisible()) this.scheduleHeartbeatIdle();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatIdleTimer)
      callClearTimer(this.clearTimer, this.heartbeatIdleTimer);
    if (this.heartbeatTimeoutTimer)
      callClearTimer(this.clearTimer, this.heartbeatTimeoutTimer);
    this.heartbeatIdleTimer = null;
    this.heartbeatTimeoutTimer = null;
    if (typeof this.heartbeatDocument?.removeEventListener === "function")
      this.heartbeatDocument.removeEventListener(
        "visibilitychange",
        this.onVisibilityChange,
      );
    if (typeof this.heartbeatWindow?.removeEventListener === "function")
      this.heartbeatWindow.removeEventListener("online", this.onOnline);
  }

  private readonly onVisibilityChange = (): void => {
    if (!this.isHeartbeatVisible()) {
      if (this.heartbeatIdleTimer)
        callClearTimer(this.clearTimer, this.heartbeatIdleTimer);
      if (this.heartbeatTimeoutTimer)
        callClearTimer(this.clearTimer, this.heartbeatTimeoutTimer);
      this.heartbeatIdleTimer = null;
      this.heartbeatTimeoutTimer = null;
      return;
    }
    this.sendHeartbeat();
  };

  private readonly onOnline = (): void => {
    if (this.isHeartbeatVisible()) this.sendHeartbeat();
  };

  private heartbeatFrameReceived(): void {
    if (!this.authenticated || !this.isHeartbeatVisible()) return;
    if (this.heartbeatTimeoutTimer)
      callClearTimer(this.clearTimer, this.heartbeatTimeoutTimer);
    this.heartbeatTimeoutTimer = null;
    this.scheduleHeartbeatIdle();
  }

  private scheduleHeartbeatIdle(): void {
    if (
      !this.authenticated ||
      !this.isHeartbeatVisible() ||
      this.heartbeatTimeoutTimer
    )
      return;
    if (this.heartbeatIdleTimer)
      callClearTimer(this.clearTimer, this.heartbeatIdleTimer);
    const minInterval =
      this.deps.heartbeatMinIntervalMs ?? HEARTBEAT_MIN_INTERVAL_MS;
    const elapsed = Date.now() - this.lastPingAt;
    const wait = Math.max(
      this.deps.heartbeatIdleMs ?? HEARTBEAT_IDLE_MS,
      this.lastPingAt ? minInterval - elapsed : 0,
    );
    this.heartbeatIdleTimer = callSetTimer(
      this.setTimer,
      () => {
        this.heartbeatIdleTimer = null;
        this.sendHeartbeat();
      },
      wait,
    );
  }

  private sendHeartbeat(): void {
    if (
      !this.authenticated ||
      !this.active ||
      !this.socket ||
      !this.isHeartbeatVisible() ||
      this.heartbeatTimeoutTimer
    )
      return;
    if (this.heartbeatIdleTimer)
      callClearTimer(this.clearTimer, this.heartbeatIdleTimer);
    this.heartbeatIdleTimer = null;
    const minInterval =
      this.deps.heartbeatMinIntervalMs ?? HEARTBEAT_MIN_INTERVAL_MS;
    const remaining = minInterval - (Date.now() - this.lastPingAt);
    if (this.lastPingAt && remaining > 0) {
      this.heartbeatIdleTimer = callSetTimer(
        this.setTimer,
        () => {
          this.heartbeatIdleTimer = null;
          this.sendHeartbeat();
        },
        remaining,
      );
      return;
    }
    try {
      this.socket.send(JSON.stringify({ type: "ping" }));
    } catch {
      this.socket.close();
      return;
    }
    this.lastPingAt = Date.now();
    this.heartbeatTimeoutTimer = callSetTimer(
      this.setTimer,
      () => {
        this.heartbeatTimeoutTimer = null;
        if (!this.active || !this.authenticated || !this.socket) return;
        this.stopHeartbeat();
        this.authenticated = false;
        const socket = this.socket;
        this.socket = null;
        socket.close();
        this.setState("offline");
        this.schedule();
      },
      this.deps.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS,
    );
  }
}

function callSetTimer(
  timer: typeof setTimeout,
  handler: TimerHandler,
  timeout: number,
): ReturnType<typeof setTimeout> {
  return timer(handler, timeout) as unknown as ReturnType<typeof setTimeout>;
}

function callClearTimer(
  timer: typeof clearTimeout,
  handle: ReturnType<typeof setTimeout>,
): void {
  timer(handle);
}
