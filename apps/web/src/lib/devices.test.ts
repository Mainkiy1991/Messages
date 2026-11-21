import { describe, expect, it } from "vitest";
import { encryptDeviceLabel } from "@messages/crypto";
import { decryptDevices } from "./devices.js";

describe("device label decryption", () => {
  it("decrypts labels and preserves row order and current", () => {
    const historyKey = new Uint8Array(32).fill(3);
    const deviceId = "a".repeat(64);
    const blob = encryptDeviceLabel({
      historyKey,
      deviceId,
      browser: "Chrome",
      os: "Windows",
    });
    expect(
      decryptDevices(
        [
          {
            deviceId,
            labelCiphertext: blob,
            createdAt: "2026-01-01",
            lastSeenAt: "2026-01-02",
            current: true,
          },
        ],
        historyKey,
      )[0],
    ).toMatchObject({
      browser: "Chrome",
      os: "Windows",
      labelKnown: true,
      current: true,
    });
  });

  it("marks damaged and mismatched labels unknown", () => {
    const historyKey = new Uint8Array(32).fill(4);
    const deviceId = "a".repeat(64);
    const mismatchedId = "b".repeat(64);
    const damaged = decryptDevices(
      [
        {
          deviceId,
          labelCiphertext: "not-a-valid-ciphertext",
          createdAt: "2026-01-01",
          lastSeenAt: "2026-01-02",
          current: false,
        },
      ],
      historyKey,
    )[0];
    expect(damaged?.labelKnown).toBe(false);

    const mismatchedBlob = encryptDeviceLabel({
      historyKey,
      deviceId: mismatchedId,
      browser: "Firefox",
      os: "Linux",
    });
    const mismatched = decryptDevices(
      [
        {
          deviceId,
          labelCiphertext: mismatchedBlob,
          createdAt: "2026-01-01",
          lastSeenAt: "2026-01-02",
          current: false,
        },
      ],
      historyKey,
    )[0];
    expect(mismatched?.labelKnown).toBe(false);
  });
});
