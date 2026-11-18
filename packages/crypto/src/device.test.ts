import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import {
  DecryptError,
  decryptDeviceLabel,
  deriveKeys,
  deviceIdFromPublicKey,
  encryptDeviceLabel,
  generateDeviceKeys,
  signAuth,
  signDeviceAuth,
  signDeviceRegistration,
  verifyDeviceAuth,
  verifyDeviceRegistration,
} from "./index.js";

const identity = deriveKeys(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
const challengeId = "01".repeat(16);
const challengeHex = "ab".repeat(32);

describe("device keys", () => {
  it("generates distinct 32-byte keys with a matching Ed25519 public key", () => {
    const first = generateDeviceKeys();
    const second = generateDeviceKeys();

    expect(first.privateKey).toHaveLength(32);
    expect(first.publicKey).toHaveLength(32);
    expect(first.publicKey).toEqual(ed25519.getPublicKey(first.privateKey));
    expect(first.privateKey).not.toEqual(second.privateKey);
    expect(first.publicKey).not.toEqual(second.publicKey);
  });

  it("formats device IDs as 64-character hex and rejects invalid key lengths", () => {
    const id = deviceIdFromPublicKey(new Uint8Array(32).fill(0xab));

    expect(id).toBe("ab".repeat(32));
    expect(id).toMatch(/^[0-9a-f]{64}$/u);
    expect(() => deviceIdFromPublicKey(new Uint8Array(31))).toThrow();
  });
});

describe("device signatures", () => {
  it("signs registration with the identity key and rejects changed inputs", () => {
    const device = generateDeviceKeys();
    const otherDevice = generateDeviceKeys();
    const signature = signDeviceRegistration(
      identity.identity.privateKey,
      challengeId,
      challengeHex,
      device.publicKey,
    );

    expect(
      verifyDeviceRegistration(
        identity.identity.publicKey,
        challengeId,
        challengeHex,
        device.publicKey,
        signature,
      ),
    ).toBe(true);
    expect(
      verifyDeviceRegistration(
        identity.identity.publicKey,
        `${challengeId}00`,
        challengeHex,
        device.publicKey,
        signature,
      ),
    ).toBe(false);
    expect(
      verifyDeviceRegistration(
        identity.identity.publicKey,
        challengeId,
        `${challengeHex.slice(0, -2)}cd`,
        device.publicKey,
        signature,
      ),
    ).toBe(false);
    expect(
      verifyDeviceRegistration(
        identity.identity.publicKey,
        challengeId,
        challengeHex,
        otherDevice.publicKey,
        signature,
      ),
    ).toBe(false);
    expect(
      verifyDeviceRegistration(
        deriveKeys(
          "legal winner thank year wave sausage worth useful legal winner thank yellow",
        ).identity.publicKey,
        challengeId,
        challengeHex,
        device.publicKey,
        signature,
      ),
    ).toBe(false);
    expect(
      verifyDeviceRegistration(
        identity.identity.publicKey,
        challengeId,
        challengeHex,
        device.publicKey,
        signature.slice(0, -1),
      ),
    ).toBe(false);
  });

  it("signs device auth and rejects changed challenges and keys", () => {
    const device = generateDeviceKeys();
    const otherDevice = generateDeviceKeys();
    const signature = signDeviceAuth(
      device.privateKey,
      challengeId,
      challengeHex,
    );

    expect(
      verifyDeviceAuth(device.publicKey, challengeId, challengeHex, signature),
    ).toBe(true);
    expect(
      verifyDeviceAuth(
        device.publicKey,
        `${challengeId}00`,
        challengeHex,
        signature,
      ),
    ).toBe(false);
    expect(
      verifyDeviceAuth(
        device.publicKey,
        challengeId,
        `${challengeHex.slice(0, -2)}cd`,
        signature,
      ),
    ).toBe(false);
    expect(
      verifyDeviceAuth(
        otherDevice.publicKey,
        challengeId,
        challengeHex,
        signature,
      ),
    ).toBe(false);
    expect(
      verifyDeviceAuth(
        device.publicKey,
        challengeId,
        challengeHex,
        signature.slice(0, -1),
      ),
    ).toBe(false);
  });

  it("domain-separates registration, device auth, and account auth", () => {
    const device = generateDeviceKeys();
    const registration = signDeviceRegistration(
      identity.identity.privateKey,
      challengeId,
      challengeHex,
      device.publicKey,
    );
    const deviceAuth = signDeviceAuth(
      identity.identity.privateKey,
      challengeId,
      challengeHex,
    );

    expect(
      verifyDeviceAuth(
        identity.identity.publicKey,
        challengeId,
        challengeHex,
        registration,
      ),
    ).toBe(false);
    expect(
      verifyDeviceRegistration(
        identity.identity.publicKey,
        challengeId,
        challengeHex,
        identity.identity.publicKey,
        deviceAuth,
      ),
    ).toBe(false);
    expect(
      verifyDeviceAuth(
        device.publicKey,
        challengeId,
        challengeHex,
        signAuth(device.privateKey, challengeId, challengeHex),
      ),
    ).toBe(false);
  });
});

describe("device labels", () => {
  const historyKey = new Uint8Array(32).fill(7);
  const deviceId = deviceIdFromPublicKey(new Uint8Array(32).fill(3));
  const label = { browser: "Firefox", os: "Windows" };

  it("encrypts and decrypts labels with randomized blobs under 512 characters", () => {
    const blob = encryptDeviceLabel({ historyKey, deviceId, ...label });
    const secondBlob = encryptDeviceLabel({ historyKey, deviceId, ...label });

    expect(decryptDeviceLabel({ historyKey, deviceId, blob })).toEqual(label);
    expect(blob).not.toBe(secondBlob);
    expect(blob.length).toBeLessThanOrEqual(512);
  });

  it("throws DecryptError for wrong keys, device IDs, and corrupted blobs", () => {
    const blob = encryptDeviceLabel({ historyKey, deviceId, ...label });
    const corruptedBlob = `${blob.slice(0, 20)}${blob[20] === "A" ? "B" : "A"}${blob.slice(21)}`;

    expect(() =>
      decryptDeviceLabel({
        historyKey: new Uint8Array(32).fill(8),
        deviceId,
        blob,
      }),
    ).toThrow(DecryptError);
    expect(() =>
      decryptDeviceLabel({
        historyKey,
        deviceId: deviceIdFromPublicKey(new Uint8Array(32).fill(4)),
        blob,
      }),
    ).toThrow(DecryptError);
    expect(() =>
      decryptDeviceLabel({ historyKey, deviceId, blob: corruptedBlob }),
    ).toThrow(DecryptError);
  });

  it("rejects empty, overlong, and control-character labels", () => {
    expect(() =>
      encryptDeviceLabel({ historyKey, deviceId, browser: "", os: label.os }),
    ).toThrow();
    expect(() =>
      encryptDeviceLabel({
        historyKey,
        deviceId,
        browser: "b".repeat(33),
        os: label.os,
      }),
    ).toThrow();
    expect(() =>
      encryptDeviceLabel({
        historyKey,
        deviceId,
        browser: label.browser,
        os: "Win\ndows",
      }),
    ).toThrow();
  });
});
