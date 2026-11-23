import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSession,
  getPinSyncVersion,
  setPinSyncVersion,
} from "./session.js";

async function putRaw(value: unknown): Promise<void> {
  const request = indexedDB.open("messages-session", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("keys");
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("keys", "readwrite");
      tx.objectStore("keys").put(value, "pinSyncVersion");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

describe("PIN sync version storage", () => {
  afterEach(async () => clearSession());
  it("defaults to version zero", async () =>
    expect(await getPinSyncVersion()).toBe("0"));
  it("writes and reads a version", async () => {
    await setPinSyncVersion("12");
    expect(await getPinSyncVersion()).toBe("12");
  });
  it("does not write a smaller version", async () => {
    await setPinSyncVersion("12");
    await setPinSyncVersion("11");
    expect(await getPinSyncVersion()).toBe("12");
  });
  it("writes a larger version", async () => {
    await setPinSyncVersion("12");
    await setPinSyncVersion("13");
    expect(await getPinSyncVersion()).toBe("13");
  });
  it("compares versions larger than Number precision with BigInt", async () => {
    await setPinSyncVersion("9223372036854775805");
    await setPinSyncVersion("9223372036854775806");
    expect(await getPinSyncVersion()).toBe("9223372036854775806");
  });
  it("reads malformed stored values as zero", async () => {
    await putRaw("not-a-version");
    expect(await getPinSyncVersion()).toBe("0");
  });
  it.each(["abc", "-1", "", "1.5", "1".repeat(20), "9223372036854775808"])(
    "rejects invalid version %s",
    async (version) => {
      await expect(setPinSyncVersion(version)).rejects.toThrow(TypeError);
    },
  );
  it("clears the version with the session database", async () => {
    await setPinSyncVersion("8");
    await clearSession();
    expect(await getPinSyncVersion()).toBe("0");
  });
});
