import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "@messages/crypto";
import {
  clearSession,
  changePin,
  disablePin,
  enablePin,
  getPinState,
  restoreSession,
  unlockWithPin,
} from "./session.js";

const keys = {
  identity: {
    privateKey: new Uint8Array(32).fill(1),
    publicKey: new Uint8Array(32).fill(2),
  },
  encryption: {
    privateKey: new Uint8Array(32).fill(3),
    publicKey: new Uint8Array(32).fill(4),
  },
  historyKey: new Uint8Array(32).fill(5),
};

describe("PIN session storage", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearSession();
  });
  it("stores only a blob, increases retry delay, changes PIN and disables it", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await enablePin(keys, "secure123");
    expect(await restoreSession()).toBeNull();
    expect(await getPinState()).toMatchObject({
      blob: { v: 1 },
      failedAttempts: 0,
    });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("messages-session");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const raw = await new Promise<string>((resolve, reject) => {
      const request = db.transaction("keys").objectStore("keys").getAll();
      request.onsuccess = () => resolve(JSON.stringify(request.result));
      request.onerror = () => reject(request.error);
    });
    db.close();
    expect(raw).not.toContain(bytesToBase64(keys.identity.privateKey));
    expect(raw).not.toContain(bytesToBase64(keys.encryption.privateKey));
    expect(raw).not.toContain(bytesToBase64(keys.historyKey));
    await expect(unlockWithPin("wrong000")).rejects.toThrow("PIN_INVALID");
    expect(await getPinState()).toMatchObject({
      failedAttempts: 1,
      nextAttemptAt: 1_001_000,
    });
    await expect(unlockWithPin("secure123")).rejects.toThrow(
      "PIN_ATTEMPT_DELAY",
    );
    now.mockReturnValue(1_001_001);
    expect(await unlockWithPin("secure123")).toEqual(keys);
    await changePin(keys, "secure123", "another99");
    await expect(unlockWithPin("secure123")).rejects.toThrow("PIN_INVALID");
    now.mockReturnValue(1_002_002);
    await expect(disablePin("another99")).resolves.toEqual(keys);
    expect(await getPinState()).toBeNull();
    expect(await restoreSession()).toEqual(keys);
  }, 90000);
});
