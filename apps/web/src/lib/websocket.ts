import { API_URL, type FetchLike, loginToServer } from "./api.js";
import type { DerivedKeys } from "@messages/crypto";

export type SocketState = "connected" | "connecting" | "offline";
export type OutgoingFrame = {
  type: "send";
  clientMsgId: string;
  to: string;
  ciphertext: string;
  senderCopy: string;
};
export type IncomingFrame = Record<string, unknown> & { type: string };
type SocketLike = Pick<
  WebSocket,
  "send" | "close" | "addEventListener" | "removeEventListener"
>;
type SocketFactory = (url: string) => SocketLike;

export class ChatConnection {
  private socket: SocketLike | null = null;
  private active = false;
  private authenticated = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: OutgoingFrame[] = [];
  private readonly pendingAck: string[] = [];
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private state: SocketState = "offline";
  private readonly seen = new Set<string>();
  private session: { token: string; expiresAt: string; userId: string };

  constructor(
    private keys: DerivedKeys,
    session: { token: string; expiresAt: string; userId: string },
    private readonly handlers: {
      onState(state: SocketState): void;
      onFrame(frame: IncomingFrame): void | Promise<void>;
      onMessageId?(id: string): void;
    },
    private readonly deps: {
      fetcher?: FetchLike;
      socketFactory?: SocketFactory;
      random?: () => number;
      setTimer?: typeof setTimeout;
      clearTimer?: typeof clearTimeout;
    } = {},
  ) {
    this.session = session;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    void this.connect();
  }
  stop(): void {
    this.active = false;
    if (this.timer) this.clearTimer(this.timer);
    if (this.ackTimer) this.clearTimer(this.ackTimer);
    this.timer = null;
    this.ackTimer = null;
    this.authenticated = false;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "logout");
    this.setState("offline");
  }
  send(frame: OutgoingFrame): void {
    this.queue.push(frame);
    if (this.authenticated) this.flush();
  }
  retryMessage(frame: OutgoingFrame): void {
    this.queue.push(frame);
    if (this.authenticated) this.flush();
  }
  hasSeen(id: string): boolean {
    return this.seen.has(id);
  }
  markSeen(id: string): void {
    this.seen.add(id);
  }

  private get setTimer(): typeof setTimeout {
    return this.deps.setTimer ?? setTimeout;
  }
  private get clearTimer(): typeof clearTimeout {
    return this.deps.clearTimer ?? clearTimeout;
  }
  private setState(state: SocketState): void {
    if (this.state !== state) {
      this.state = state;
      this.handlers.onState(state);
    }
  }
  private url(): string {
    return `${API_URL.replace(/^http/u, "ws")}/ws`;
  }
  private async connect(): Promise<void> {
    if (!this.active) return;
    this.setState("connecting");
    try {
      if (Date.parse(this.session.expiresAt) <= Date.now())
        this.session = await loginToServer(this.keys, this.deps.fetcher);
      const socket = (this.deps.socketFactory ?? ((url) => new WebSocket(url)))(
        this.url(),
      );
      this.socket = socket;
      socket.addEventListener("open", () => {
        if (this.active && this.socket === socket)
          socket.send(
            JSON.stringify({ type: "auth", token: this.session.token }),
          );
      });
      socket.addEventListener("message", (event) => {
        if (this.active && this.socket === socket)
          void this.receive(event.data);
      });
      socket.addEventListener("close", (event) => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.authenticated = false;
        if (!this.active) return;
        if (event.code === 4401) {
          this.schedule(0, true);
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
      this.setState("connected");
      this.flush();
      return;
    }
    if (frame.type === "message" && typeof frame.id === "string") {
      const duplicate = this.seen.has(frame.id);
      if (!duplicate) {
        this.seen.add(frame.id);
        try {
          await this.handlers.onFrame(frame);
        } catch {
          /* Receive errors are rendered by caller */
        }
      }
      this.enqueueAck(frame.id);
      return;
    }
    if (
      frame.type === "sent" &&
      typeof frame.clientMsgId === "string" &&
      typeof frame.id === "string"
    )
      this.handlers.onMessageId?.(frame.clientMsgId);
    await this.handlers.onFrame(frame);
  }
  private flush(): void {
    while (this.authenticated && this.queue.length && this.socket)
      this.socket.send(JSON.stringify(this.queue.shift()));
  }
  private enqueueAck(id: string): void {
    this.pendingAck.push(id);
    if (this.pendingAck.length >= 200) {
      this.flushAcks();
      return;
    }
    if (!this.ackTimer)
      this.ackTimer = this.setTimer(() => {
        this.ackTimer = null;
        this.flushAcks();
      }, 50);
  }
  private flushAcks(): void {
    if (this.ackTimer) this.clearTimer(this.ackTimer);
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
    this.timer = this.setTimer(() => {
      this.timer = null;
      void (async () => {
        if (!this.active) return;
        if (renew) {
          try {
            this.session = await loginToServer(this.keys, this.deps.fetcher);
          } catch {
            this.schedule();
            return;
          }
        }
        await this.connect();
      })();
    }, jittered);
  }
}
