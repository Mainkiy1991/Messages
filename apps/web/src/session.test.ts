import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { clearSession, restoreSession, saveSession } from "./session.js";

const sample = {
  identity: { privateKey: new Uint8Array([1]), publicKey: new Uint8Array([2]) },
  encryption: {
    privateKey: new Uint8Array([3]),
    publicKey: new Uint8Array([4]),
  },
  historyKey: new Uint8Array([5]),
};

describe("session storage", () => {
  afterEach(async () => {
    await clearSession();
  });
  it("saves, restores, and clears derived keys", async () => {
    expect(await restoreSession()).toBeNull();
    await saveSession(sample);
    expect(await restoreSession()).toEqual(sample);
    await clearSession();
    expect(await restoreSession()).toBeNull();
  });
});
