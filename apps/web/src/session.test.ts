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
  restoreServerSession,
  type DeviceKeys,
} from "./session.js";
import { generateDeviceKeys, bytesToHex } from "@messages/crypto";

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
  });

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
});
