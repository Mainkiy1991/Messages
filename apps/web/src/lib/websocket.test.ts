import { describe, expect, it, vi } from "vitest";
import {
  deriveKeys,
  generateDeviceKeys,
  userIdFromPublicKey,
} from "@messages/crypto";
import { DeviceRevokedError } from "./api.js";
import {
  ChatConnection,
  resolveWebSocketUrl,
  type OutgoingFrame,
} from "./websocket.js";

describe("WebSocket server address", () => {
  it("converts configured HTTP addresses and defaults to localhost in development", () => {
    expect(resolveWebSocketUrl("http://localhost:3000/")).toBe(
      "ws://localhost:3000/ws",
    );
    expect(resolveWebSocketUrl("https://messages-server.onrender.com")).toBe(
      "wss://messages-server.onrender.com/ws",
    );
    expect(resolveWebSocketUrl()).toBe("ws://localhost:3000/ws");
  });
});

class FakeSocket extends EventTarget {
  sent: string[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
  open() {
    this.dispatchEvent(new Event("open"));
  }
  frame(value: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for websocket test condition");
}

describe("websocket chat connection", () => {
  it("pings after idle and closes after the heartbeat timeout", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const states: string[] = [];
    const doc = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    const keys = deriveKeys(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    const connection = new ChatConnection(
      keys,
      {
        token: "a".repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: userIdFromPublicKey(keys.identity.publicKey),
      },
      { onState: (state) => states.push(state), onFrame: vi.fn() },
      {
        socketFactory: () => socket,
        heartbeatIdleMs: 25,
        heartbeatTimeoutMs: 10,
        document: doc,
      },
    );
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    socket.frame({ type: "auth_ok" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(24);
    expect(socket.sent.map((value) => JSON.parse(value).type)).not.toContain(
      "ping",
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sent.map((value) => JSON.parse(value).type)).toContain(
      "ping",
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(socket.closed).toBe(true);
    expect((connection as unknown as { state: string }).state).toBe("offline");
    connection.stop();
    vi.useRealTimers();
  });

  it("ignores close, error, and message events from the timed-out socket", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const states: string[] = [];
    const doc = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    const keys = deriveKeys(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    const connection = new ChatConnection(
      keys,
      {
        token: "a".repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: userIdFromPublicKey(keys.identity.publicKey),
      },
      { onState: (state) => states.push(state), onFrame: vi.fn() },
      {
        socketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        heartbeatIdleMs: 10,
        heartbeatTimeoutMs: 10,
        heartbeatMinIntervalMs: 5,
        document: doc,
        random: () => 0,
      },
    );
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    const oldSocket = sockets[0]!;
    oldSocket.frame({ type: "auth_ok" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(oldSocket.closed).toBe(true);
    const statesAfterTimeout = [...states];
    oldSocket.frame({ type: "message", id: "late-frame" });
    oldSocket.dispatchEvent(new Event("error"));
    oldSocket.close();
    expect(states).toEqual(statesAfterTimeout);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sockets).toHaveLength(2);
    connection.stop();
    vi.useRealTimers();
  });

  it("resets heartbeat on any frame and pauses while hidden until visibility returns", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const doc = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    const win = new EventTarget();
    const removeVisibilityListener = vi.spyOn(doc, "removeEventListener");
    const removeOnlineListener = vi.spyOn(win, "removeEventListener");
    const keys = deriveKeys(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    const connection = new ChatConnection(
      keys,
      {
        token: "a".repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: userIdFromPublicKey(keys.identity.publicKey),
      },
      { onState: vi.fn(), onFrame: vi.fn() },
      {
        socketFactory: () => socket,
        heartbeatIdleMs: 25,
        heartbeatTimeoutMs: 10,
        heartbeatMinIntervalMs: 5,
        document: doc,
        window: win,
      },
    );
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    socket.frame({ type: "auth_ok" });
    await vi.advanceTimersByTimeAsync(20);
    socket.frame({ type: "unrelated" });
    await vi.advanceTimersByTimeAsync(20);
    expect(socket.sent.map((value) => JSON.parse(value).type)).not.toContain(
      "ping",
    );
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60);
    expect(socket.sent.map((value) => JSON.parse(value).type)).not.toContain(
      "ping",
    );
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(
      socket.sent
        .map((value) => JSON.parse(value).type)
        .filter((type) => type === "ping"),
    ).toHaveLength(1);
    win.dispatchEvent(new Event("online"));
    expect(
      socket.sent
        .map((value) => JSON.parse(value).type)
        .filter((type) => type === "ping"),
    ).toHaveLength(1);
    connection.stop();
    expect(removeVisibilityListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    expect(removeOnlineListener).toHaveBeenCalledWith(
      "online",
      expect.any(Function),
    );
    vi.useRealTimers();
  });

  it("calls injected timers without a receiver for ack, send timeout, reconnect, and stop", async () => {
    vi.useFakeTimers();
    const nativeSet = globalThis.setTimeout;
    const nativeClear = globalThis.clearTimeout;
    const setTimer = vi.fn(function (
      this: unknown,
      handler: TimerHandler,
      ms?: number,
    ) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return nativeSet(handler, ms);
    }) as unknown as typeof setTimeout;
    const clearTimer = vi.fn(function (this: unknown, handle: number) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      nativeClear(handle);
    }) as typeof clearTimeout;
    const keys = deriveKeys(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    const sockets: FakeSocket[] = [];
    const onSendTimeout = vi.fn();
    const connection = new ChatConnection(
      keys,
      {
        token: "a".repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: userIdFromPublicKey(keys.identity.publicKey),
      },
      { onState: vi.fn(), onFrame: vi.fn(), onSendTimeout },
      {
        socketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        setTimer,
        clearTimer,
        random: () => 0,
        sendTimeoutMs: 100,
      },
    );
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();
    sockets[0]!.frame({ type: "auth_ok" });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.frame({ type: "message", id: "message-1" });
    await vi.advanceTimersByTimeAsync(50);
    expect(sockets[0]!.sent.map((value) => JSON.parse(value).type)).toContain(
      "ack",
    );
    connection.send({
      type: "send",
      clientMsgId: "send-1",
      to: "02",
      ciphertext: "c",
      senderCopy: "s",
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(onSendTimeout).toHaveBeenCalledWith("send-1");
    expect(setTimer).toHaveBeenCalled();
    sockets[0]!.close();
    await vi.advanceTimersByTimeAsync(800);
    expect(sockets).toHaveLength(2);
    sockets[1]!.frame({ type: "message", id: "message-stop" });
    sockets[1]!.open();
    sockets[1]!.frame({ type: "auth_ok" });
    await vi.advanceTimersByTimeAsync(0);
    sockets[1]!.frame({ type: "message", id: "message-stop-2" });
    await vi.advanceTimersByTimeAsync(0);
    connection.stop();
    expect(clearTimer).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    vi.useRealTimers();
  });

  it("uses default global timers as free functions", async () => {
    vi.useFakeTimers();
    const nativeSet = globalThis.setTimeout;
    const nativeClear = globalThis.clearTimeout;
    vi.stubGlobal(
      "setTimeout",
      function (this: unknown, handler: TimerHandler, ms?: number) {
        if (this !== undefined) throw new TypeError("Illegal invocation");
        return nativeSet(handler, ms);
      },
    );
    vi.stubGlobal("clearTimeout", function (this: unknown, handle: number) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      nativeClear(handle);
    });
    const keys = deriveKeys(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    const socket = new FakeSocket();
    const connection = new ChatConnection(
      keys,
      {
        token: "a".repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: userIdFromPublicKey(keys.identity.publicKey),
      },
      { onState: vi.fn(), onFrame: vi.fn() },
      { socketFactory: () => socket as never },
    );
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    socket.open();
    socket.frame({ type: "auth_ok" });
    socket.close();
    await vi.advanceTimersByTimeAsync(800);
    connection.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("authenticates first and flushes queued frames only after auth_ok", async () => {
    const socket = new FakeSocket();
    const socketFactory = vi.fn(() => socket as never);
    const keys = deriveKeys(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    const connection = new ChatConnection(
      keys,
      {
        token: "a".repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: userIdFromPublicKey(keys.identity.publicKey),
      },
      { onState: vi.fn(), onFrame: vi.fn() },
      { socketFactory },
    );
    const outgoing: OutgoingFrame = {
      type: "send",
      clientMsgId: "01".repeat(16),
      to: "02".repeat(32),
      ciphertext: "cipher",
      senderCopy: "copy",
    };
    connection.send(outgoing);
    connection.start();
    await waitFor(() => socketFactory.mock.calls.length === 1);
    socket.open();
    expect(JSON.parse(socket.sent[0]!).type).toBe("auth");
    expect(socket.sent).toHaveLength(1);
    socket.frame({ type: "auth_ok", userId: "0".repeat(64) });
    await waitFor(() => socket.sent.length === 2);
    expect(JSON.parse(socket.sent[1]!)).toEqual(outgoing);
    connection.stop();
  });

  it("pauses queued sends until clear metadata loads and drops cleared-peer retries", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const keys = deriveKeys(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    const connection = new ChatConnection(
      keys,
      {
        token: "a".repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: userIdFromPublicKey(keys.identity.publicKey),
      },
      { onState: vi.fn(), onFrame: vi.fn() },
      {
        socketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        random: () => 0,
      },
    );
    const outgoing: OutgoingFrame = {
      type: "send",
      clientMsgId: "03".repeat(16),
      to: "04".repeat(32),
      ciphertext: "cipher",
      senderCopy: "copy",
    };
    connection.setSendingPaused(true);
    connection.send(outgoing);
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();
    sockets[0]!.frame({ type: "auth_ok" });
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.sent.map((value) => JSON.parse(value).type)).toEqual([
      "auth",
    ]);

    connection.setSendingPaused(false);
    expect(JSON.parse(sockets[0]!.sent[1]!)).toEqual(outgoing);
    connection.clearPeer(outgoing.to);
    sockets[0]!.close();
    await vi.advanceTimersByTimeAsync(800);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    sockets[1]!.frame({ type: "auth_ok" });
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[1]!.sent.map((value) => JSON.parse(value).type)).toEqual([
      "auth",
    ]);
    connection.stop();
    vi.useRealTimers();
  });

  it("handles device revocation once and does not schedule timers", async () => {
    vi.useFakeTimers();
    const derived = deriveKeys(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    const device = generateDeviceKeys();
    const deviceKeys = {
      identityPublicKey: derived.identity.publicKey,
      encryption: derived.encryption,
      historyKey: derived.historyKey,
      device,
    };
    const onRevoked = vi.fn();
    const setTimer = vi.fn((callback: TimerHandler, _ms?: number) =>
      setTimeout(callback, _ms),
    );
    const login = vi.fn().mockRejectedValue(new DeviceRevokedError());
    const states: string[] = [];
    const connection = new ChatConnection(
      deviceKeys,
      null,
      {
        onState: (state) => states.push(state),
        onFrame: vi.fn(),
        onRevoked,
      },
      {
        login,
        setTimer: setTimer as unknown as typeof setTimeout,
        clearTimer: clearTimeout,
      },
    );
    await expect(connection.refreshSession()).rejects.toBeInstanceOf(
      DeviceRevokedError,
    );
    await expect(connection.refreshSession()).rejects.toBeInstanceOf(
      DeviceRevokedError,
    );
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledTimes(1);
    expect((connection as unknown as { state: string }).state).toBe("offline");
    expect(setTimer).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("retries a network refresh as before", async () => {
    const keys = deriveKeys(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    let attempts = 0;
    const connection = new ChatConnection(
      keys,
      null,
      { onState: vi.fn(), onFrame: vi.fn() },
      {
        login: async () => {
          attempts++;
          if (attempts === 1) throw new TypeError("offline");
          return {
            token: "recovered",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            userId: userIdFromPublicKey(keys.identity.publicKey),
          };
        },
      },
    );
    await expect(connection.refreshSession()).rejects.toBeInstanceOf(TypeError);
    await expect(connection.refreshSession()).resolves.toMatchObject({
      token: "recovered",
    });
    expect(attempts).toBe(2);
  });

  it("acks duplicate inbound ids without rendering them twice", async () => {
    const socket = new FakeSocket();
    const socketFactory = vi.fn(() => socket as never);
    const keys = deriveKeys(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    const onFrame = vi.fn();
    const onState = vi.fn();
    const connection = new ChatConnection(
      keys,
      {
        token: "a".repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: userIdFromPublicKey(keys.identity.publicKey),
      },
      { onState, onFrame },
      { socketFactory },
    );
    connection.start();
    await waitFor(() => socketFactory.mock.calls.length === 1);
    socket.open();
    socket.frame({ type: "auth_ok" });
    await waitFor(() =>
      onState.mock.calls.some(([state]) => state === "connected"),
    );
    const frame = {
      type: "message",
      id: "00000000-0000-4000-8000-000000000001",
      from: "1".repeat(64),
      ciphertext: "x",
      createdAt: new Date().toISOString(),
    };
    socket.frame(frame);
    socket.frame(frame);
    await waitFor(() =>
      socket.sent.some((value) => JSON.parse(value).type === "ack"),
    );
    expect(onFrame).toHaveBeenCalledTimes(1);
    const acks = socket.sent
      .filter((value) => JSON.parse(value).type === "ack")
      .map((value) => JSON.parse(value).ids)
      .flat();
    expect(acks).toEqual([frame.id, frame.id]);
    connection.stop();
  });

  it("drops malformed messages-erased frames", async () => {
    const socket = new FakeSocket();
    const socketFactory = vi.fn(() => socket as never);
    const keys = deriveKeys(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    const onFrame = vi.fn();
    const connection = new ChatConnection(
      keys,
      {
        token: "a".repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: userIdFromPublicKey(keys.identity.publicKey),
      },
      { onState: vi.fn(), onFrame },
      { socketFactory },
    );
    connection.start();
    await waitFor(() => socketFactory.mock.calls.length === 1);
    socket.open();
    socket.frame({ type: "auth_ok" });
    await waitFor(() => onFrame.mock.calls.length === 0);
    socket.frame({
      type: "messages_erased",
      from: "1".repeat(64),
      to: "2".repeat(64),
      upToSeq: 5,
      changeSeq: "10",
    });
    const valid = {
      type: "messages_erased",
      from: "1".repeat(64),
      to: "2".repeat(64),
      upToSeq: "5",
      changeSeq: "10",
    };
    socket.frame(valid);
    await waitFor(() => onFrame.mock.calls.length === 1);
    expect(onFrame).toHaveBeenCalledWith(valid);
    connection.stop();
  });

  it("drops malformed own_message frames and forwards valid frames without ack", async () => {
    const socket = new FakeSocket();
    const socketFactory = vi.fn(() => socket as never);
    const keys = deriveKeys(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    const onFrame = vi.fn();
    const connection = new ChatConnection(
      keys,
      {
        token: "a".repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: userIdFromPublicKey(keys.identity.publicKey),
      },
      { onState: vi.fn(), onFrame },
      { socketFactory },
    );
    connection.start();
    await waitFor(() => socketFactory.mock.calls.length === 1);
    socket.open();
    socket.frame({ type: "auth_ok" });
    await waitFor(() => connection.currentToken() !== null);
    const valid = {
      type: "own_message",
      id: "00000000-0000-4000-8000-000000000001",
      to: "1".repeat(64),
      clientMsgId: "2".repeat(32),
      senderCopy: "encrypted-copy",
      createdAt: new Date().toISOString(),
      seq: "123",
    };
    socket.frame({ ...valid, to: "short", seq: 123 });
    socket.frame(valid);
    await waitFor(() => onFrame.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(onFrame).toHaveBeenCalledWith(valid);
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(connection.hasSeen(valid.id)).toBe(false);
    expect(socket.sent.map((value) => JSON.parse(value).type)).not.toContain(
      "ack",
    );
    connection.stop();
  });

  it("splits acknowledgement batches at 200 IDs", async () => {
    const socket = new FakeSocket();
    const socketFactory = vi.fn(() => socket as never);
    const onState = vi.fn();
    const keys = deriveKeys(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    const connection = new ChatConnection(
      keys,
      {
        token: "a".repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: userIdFromPublicKey(keys.identity.publicKey),
      },
      { onState, onFrame: vi.fn() },
      { socketFactory },
    );
    connection.start();
    await waitFor(() => socketFactory.mock.calls.length === 1);
    socket.open();
    socket.frame({ type: "auth_ok" });
    await waitFor(() =>
      onState.mock.calls.some(([state]) => state === "connected"),
    );
    for (let index = 0; index < 205; index++) {
      socket.frame({
        type: "message",
        id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
        from: "1".repeat(64),
        ciphertext: "x",
        createdAt: new Date().toISOString(),
      });
    }
    await waitFor(
      () =>
        socket.sent.filter((value) => JSON.parse(value).type === "ack")
          .length === 2,
    );
    const batches = socket.sent
      .filter((value) => JSON.parse(value).type === "ack")
      .map((value) => JSON.parse(value).ids as string[]);
    expect(batches.map((ids) => ids.length)).toEqual([200, 5]);
    expect(batches.every((ids) => ids.length <= 200)).toBe(true);
    connection.stop();
  });
});
