import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSession,
  restoreSession,
  saveSession,
  saveDeviceAccount,
  packKeys,
  unpackKeys,
  enablePin,
  unlockWithPin,
  disablePin,
  changePin,
  restoreServerSession,
  type DeviceKeys,
} from "./session.js";
import {
  generateDeviceKeys,
  bytesToHex,
  unwrapServerSession,
} from "@messages/crypto";

const sample = {
  identity: { privateKey: new Uint8Array([1]), publicKey: new Uint8Array([2]) },
  encryption: {
    privateKey: new Uint8Array([3]),
    publicKey: new Uint8Array([4]),
  },
  historyKey: new Uint8Array([5]),
};

async function readStoreKey(key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("messages-session");
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("keys"))
        request.result.createObjectStore("keys");
    };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("keys")) {
        db.close();
        resolve(undefined);
        return;
      }
      const get = db.transaction("keys").objectStore("keys").get(key);
      get.onsuccess = () => {
        resolve(get.result);
        db.close();
      };
      get.onerror = () => {
        reject(get.error);
        db.close();
      };
    };
    request.onerror = () => reject(request.error);
  });
}

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

  it("round-trips device keys and encrypted PIN session", async () => {
    const device = generateDeviceKeys();
    const keys: DeviceKeys = {
      identityPublicKey: new Uint8Array(32).fill(1),
      encryption: {
        privateKey: new Uint8Array(32).fill(2),
        publicKey: new Uint8Array(32).fill(3),
      },
      historyKey: new Uint8Array(32).fill(4),
      device,
    };
    const session = {
      token: "token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      userId: bytesToHex(keys.identityPublicKey),
      deviceId: bytesToHex(device.publicKey),
    };
    await saveDeviceAccount(keys, session);
    expect(await restoreSession()).toEqual(keys);
    expect(await restoreServerSession(keys)).toEqual(session);

    await enablePin(keys, "12345678");
    expect(await restoreSession()).toBeNull();
    expect(await unlockWithPin("12345678")).toEqual(keys);
    expect(await restoreServerSession(keys)).toEqual(session);
    expect(await disablePin("12345678")).toEqual(keys);
  }, 90000);

  it("packs and unpacks v2 device keys without identity private key", () => {
    const keys: DeviceKeys = {
      identityPublicKey: new Uint8Array(32).fill(1),
      encryption: {
        privateKey: new Uint8Array(32).fill(2),
        publicKey: new Uint8Array(32).fill(3),
      },
      historyKey: new Uint8Array(32).fill(4),
      device: generateDeviceKeys(),
    };
    const packed = packKeys(keys);
    expect(JSON.parse(new TextDecoder().decode(packed))).not.toHaveProperty(
      "identity",
    );
    expect(unpackKeys(packed)).toEqual(keys);
  });

  it("changes PIN for device keys and removes the open device key", async () => {
    const device = generateDeviceKeys();
    const keys: DeviceKeys = {
      identityPublicKey: new Uint8Array(32).fill(11),
      encryption: {
        privateKey: new Uint8Array(32).fill(12),
        publicKey: new Uint8Array(32).fill(13),
      },
      historyKey: new Uint8Array(32).fill(14),
      device,
    };
    const session = {
      token: "device-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      userId: bytesToHex(keys.identityPublicKey),
      deviceId: bytesToHex(device.publicKey),
    };
    await saveDeviceAccount(keys, session);
    await enablePin(keys, "old-pin-123");

    const rawDeviceKey = await readStoreKey("deviceKeys");
    expect(rawDeviceKey).toBeUndefined();

    await changePin(keys, "old-pin-123", "new-pin-456");
    await expect(unlockWithPin("old-pin-123")).rejects.toThrow();
    await expect(unlockWithPin("new-pin-456")).resolves.toEqual(keys);

    const otherKey = new Uint8Array(32).fill(99);
    const storedSession = await readStoreKey("serverSession");
    expect(() =>
      unwrapServerSession(
        storedSession as Parameters<typeof unwrapServerSession>[0],
        otherKey,
      ),
    ).toThrow();
  }, 90000);

  it("does not store identity in the open device key object", async () => {
    const device = generateDeviceKeys();
    const keys: DeviceKeys = {
      identityPublicKey: new Uint8Array(32).fill(21),
      encryption: {
        privateKey: new Uint8Array(32).fill(22),
        publicKey: new Uint8Array(32).fill(23),
      },
      historyKey: new Uint8Array(32).fill(24),
      device,
    };
    await saveDeviceAccount(keys, {
      token: "token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      userId: bytesToHex(keys.identityPublicKey),
      deviceId: bytesToHex(device.publicKey),
    });
    const raw = await readStoreKey("deviceKeys");
    expect(raw).not.toHaveProperty("identity");
  });
});
