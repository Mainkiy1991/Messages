import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "@messages/crypto";
import {
  clearSession,
  changePin,
  disablePin,
  enablePin,
  getPinState,
  pinFailureState,
  restoreSession,
  restoreServerSession,
  saveServerSession,
  unlockWithPin,
} from "./session.js";

const mockWrappedSecrets = vi.hoisted(() => ({
  nextId: 0,
  failKdf: false,
  values: new Map<string, { pin: string; secrets: Uint8Array }>(),
}));
vi.mock("@messages/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@messages/crypto")>();
  return {
    ...actual,
    wrapSecrets: vi.fn(async (secrets: Uint8Array, pin: string) => {
      const ciphertext = String(++mockWrappedSecrets.nextId);
      mockWrappedSecrets.values.set(ciphertext, {
        pin,
        secrets: secrets.slice(),
      });
      return {
        v: 1 as const,
        kdf: "argon2id" as const,
        mem: 65536 as const,
        iters: 3 as const,
        salt: "",
        nonce: "",
        ciphertext,
      };
    }),
    unwrapSecrets: vi.fn(async (blob: unknown, pin: string) => {
      if (mockWrappedSecrets.failKdf) throw new Error("PIN_KDF_FAILED");
      if (!blob || typeof blob !== "object" || !("ciphertext" in blob))
        throw new Error("PIN_INVALID");
      const record = mockWrappedSecrets.values.get(String(blob.ciphertext));
      if (!record || record.pin !== pin) throw new Error("PIN_INVALID");
      return record.secrets.slice();
    }),
  };
});

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
    mockWrappedSecrets.failKdf = false;
    mockWrappedSecrets.values.clear();
  });
  it("stores only a blob, increases retry delay, changes PIN and disables it", async () => {
    const serverSession = {
      token: "secret-server-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      userId: "user-id",
    };
    await saveServerSession(serverSession, keys);
    await enablePin(keys, "secure123");
    const storedSession = await new Promise<unknown>((resolve, reject) => {
      const request = indexedDB.open("messages-session");
      request.onsuccess = () => {
        const db = request.result;
        const get = db
          .transaction("keys")
          .objectStore("keys")
          .get("serverSession");
        get.onsuccess = () => {
          resolve(get.result);
          db.close();
        };
        get.onerror = () => reject(get.error);
      };
      request.onerror = () => reject(request.error);
    });
    expect(JSON.stringify(storedSession)).not.toContain("secret-server-token");
    expect(await restoreServerSession(keys)).toEqual(serverSession);
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
      nextAttemptAt: 0,
    });
    expect(await unlockWithPin("secure123")).toEqual(keys);
    expect(await getPinState()).toMatchObject({
      failedAttempts: 0,
      nextAttemptAt: 0,
    });
    await changePin(keys, "secure123", "another99");
    await expect(unlockWithPin("secure123")).rejects.toThrow("PIN_INVALID");
    await expect(disablePin("another99")).resolves.toEqual(keys);
    expect(await getPinState()).toBeNull();
    expect(await restoreSession()).toEqual(keys);
    expect(await restoreServerSession(keys)).toEqual(serverSession);
  }, 90000);

  it("removes a legacy plaintext server session while PIN protection is active", async () => {
    await enablePin(keys, "secure123");
    await saveServerSession(
      {
        token: "legacy-plaintext-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: "user-id",
      },
      keys,
    );
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("messages-session");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("keys", "readwrite");
      tx.objectStore("keys").put(
        {
          token: "legacy-plaintext-token",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          userId: "user-id",
        },
        "serverSession",
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    expect(await getPinState()).not.toBeNull();
    expect(await restoreServerSession(keys)).toBeNull();
  });

  it("uses the increasing lockout schedule", () => {
    let now = 1_000;
    const expectedDelays = [
      0,
      0,
      0,
      0,
      5 * 60_000,
      15 * 60_000,
      60 * 60_000,
      60 * 60_000,
    ];
    for (const [index, delay] of expectedDelays.entries()) {
      const state = pinFailureState(index + 1, now);
      expect(state.failedAttempts).toBe(index + 1);
      expect(state.nextAttemptAt).toBe(delay ? now + delay : 0);
      if (delay) now += delay;
    }
  });

  it("does not count KDF failures as incorrect PIN attempts", async () => {
    await enablePin(keys, "secure123");
    mockWrappedSecrets.failKdf = true;
    await expect(unlockWithPin("secure123")).rejects.toThrow("PIN_KDF_FAILED");
    expect(await getPinState()).toMatchObject({
      failedAttempts: 0,
      nextAttemptAt: 0,
    });

    mockWrappedSecrets.failKdf = false;
    await expect(unlockWithPin("wrong000")).rejects.toThrow("PIN_INVALID");
    expect(await getPinState()).toMatchObject({
      failedAttempts: 1,
      nextAttemptAt: 0,
    });
  }, 30000);

  it("persists an active lockout and refuses PIN checks until it expires", async () => {
    await enablePin(keys, "secure123");
    const state = await getPinState();
    expect(state).not.toBeNull();
    const nextAttemptAt = Date.now() + 5 * 60_000;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("messages-session");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("keys", "readwrite");
      tx.objectStore("keys").put(
        { ...state!, failedAttempts: 5, nextAttemptAt },
        "pinState",
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    await expect(unlockWithPin("secure123")).rejects.toThrow(
      "PIN_ATTEMPT_DELAY",
    );
    await expect(changePin(keys, "secure123", "newsecure123")).rejects.toThrow(
      "PIN_ATTEMPT_DELAY",
    );
    await expect(disablePin("secure123")).rejects.toThrow("PIN_ATTEMPT_DELAY");
    expect(await getPinState()).toMatchObject({
      failedAttempts: 5,
      nextAttemptAt,
    });
  }, 30000);
});
