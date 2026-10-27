import { describe, expect, it, vi } from "vitest";
import { deriveKeys, userIdFromPublicKey } from "@messages/crypto";
import { ChatConnection, type OutgoingFrame } from "./websocket.js";

class FakeSocket extends EventTarget {
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
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
