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
});
