import { describe, expect, it, vi } from "vitest";
import { deriveKeys } from "@messages/crypto";
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

describe("websocket chat connection", () => {
  it("authenticates first and flushes queued frames only after auth_ok", async () => {
    const socket = new FakeSocket();
    const connection = new ChatConnection(
      deriveKeys(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      ),
      {
        token: "a".repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: "0".repeat(64),
      },
      { onState: vi.fn(), onFrame: vi.fn() },
      { socketFactory: () => socket as never },
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
    socket.open();
    expect(JSON.parse(socket.sent[0]!).type).toBe("auth");
    expect(socket.sent).toHaveLength(1);
    socket.frame({ type: "auth_ok", userId: "0".repeat(64) });
    expect(JSON.parse(socket.sent[1]!)).toEqual(outgoing);
    connection.stop();
  });

  it("acks duplicate inbound ids without rendering them twice", async () => {
    const socket = new FakeSocket();
    const onFrame = vi.fn();
    const connection = new ChatConnection(
      deriveKeys(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      ),
      {
        token: "a".repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: "0".repeat(64),
      },
      { onState: vi.fn(), onFrame },
      { socketFactory: () => socket as never },
    );
    connection.start();
    socket.open();
    socket.frame({ type: "auth_ok" });
    const frame = {
      type: "message",
      id: "00000000-0000-4000-8000-000000000001",
      from: "1".repeat(64),
      ciphertext: "x",
      createdAt: new Date().toISOString(),
    };
    socket.frame(frame);
    socket.frame(frame);
    await new Promise((resolve) => setTimeout(resolve, 70));
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
    const connection = new ChatConnection(
      deriveKeys(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      ),
      {
        token: "a".repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: "0".repeat(64),
      },
      { onState: vi.fn(), onFrame: vi.fn() },
      { socketFactory: () => socket as never },
    );
    connection.start();
    socket.open();
    socket.frame({ type: "auth_ok" });
    for (let index = 0; index < 205; index++) {
      socket.frame({
        type: "message",
        id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
        from: "1".repeat(64),
        ciphertext: "x",
        createdAt: new Date().toISOString(),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 70));
    const batches = socket.sent
      .filter((value) => JSON.parse(value).type === "ack")
      .map((value) => JSON.parse(value).ids as string[]);
    expect(batches.map((ids) => ids.length)).toEqual([200, 5]);
    expect(batches.every((ids) => ids.length <= 200)).toBe(true);
    connection.stop();
  });
});
