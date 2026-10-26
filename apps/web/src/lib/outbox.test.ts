import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { indexedDbOutbox } from "./outbox.js";

describe("encrypted IndexedDB outbox", () => {
  afterEach(async () => indexedDbOutbox.clear());

  it("persists encrypted frames per account and removes acknowledged frames", async () => {
    const frame = {
      type: "send" as const,
      clientMsgId: "msg-1",
      to: "peer",
      ciphertext: "ciphertext",
      senderCopy: "encrypted-copy",
    };
    await indexedDbOutbox.put("user-a", frame);
    expect(await indexedDbOutbox.list("user-a")).toEqual([frame]);
    expect(await indexedDbOutbox.list("user-b")).toEqual([]);
    await indexedDbOutbox.remove("user-a", "msg-1");
    expect(await indexedDbOutbox.list("user-a")).toEqual([]);
  });

  it("removes queued frames only for the cleared peer and account", async () => {
    const frame = (clientMsgId: string, to: string) => ({
      type: "send" as const,
      clientMsgId,
      to,
      ciphertext: "ciphertext",
      senderCopy: "encrypted-copy",
    });
    await indexedDbOutbox.put("user-a", frame("msg-a", "peer-a"));
    await indexedDbOutbox.put("user-a", frame("msg-b", "peer-b"));
    await indexedDbOutbox.put("user-b", frame("msg-c", "peer-a"));
    await indexedDbOutbox.removeForPeer!("user-a", "peer-a");
    expect(await indexedDbOutbox.list("user-a")).toEqual([
      frame("msg-b", "peer-b"),
    ]);
    expect(await indexedDbOutbox.list("user-b")).toEqual([
      frame("msg-c", "peer-a"),
    ]);
  });
});
