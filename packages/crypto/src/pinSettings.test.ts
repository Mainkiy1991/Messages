import { describe, expect, it } from "vitest";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import {
  base64ToBytes,
  bytesToBase64,
  decryptContactBook,
  decryptPinSettings,
  encryptContactBook,
  encryptPinSettings,
  DecryptError,
} from "./index.js";

const historyKey = new Uint8Array(32).fill(7);
const userId = "a".repeat(64);
const otherUserId = "b".repeat(64);
const enabled = { enabled: true, pin: "123456", updatedAt: 42 };

function forged(plaintext: Uint8Array, id = userId): string {
  const salt = new Uint8Array(32);
  const label = new TextEncoder().encode("messages/v1/pin-settings");
  const key = hkdf(sha256, historyKey, salt, label, 32);
  const nonce = new Uint8Array(24).fill(9);
  const aad = new TextEncoder().encode(`messages/v1/pin-settings\n${id}`);
  return bytesToBase64(
    concat(
      Uint8Array.of(1),
      nonce,
      xchacha20poly1305(key, nonce, aad).encrypt(plaintext),
    ),
  );
}
function packedJson(json: string, tailByte = 0): Uint8Array {
  const data = new TextEncoder().encode(json);
  const packed = new Uint8Array(512);
  packed[0] = data.length >> 8;
  packed[1] = data.length & 255;
  packed.set(data, 2);
  if (tailByte) packed[2 + data.length] = tailByte;
  return packed;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function expectDecryptError(blob: string, key = historyKey, id = userId) {
  expect(() =>
    decryptPinSettings({ historyKey: key, userId: id, blob }),
  ).toThrow(DecryptError);
}

describe("PIN settings envelope", () => {
  it("round trips enabled PIN settings", () => {
    expect(
      decryptPinSettings({
        historyKey,
        userId,
        blob: encryptPinSettings({ historyKey, userId, ...enabled }),
      }),
    ).toEqual(enabled);
  });
  it("round trips disabled PIN settings with an empty PIN", () => {
    const settings = { enabled: false, pin: "", updatedAt: 0 };
    expect(
      decryptPinSettings({
        historyKey,
        userId,
        blob: encryptPinSettings({ historyKey, userId, ...settings }),
      }),
    ).toEqual(settings);
  });
  it("normalizes fullwidth PIN digits to NFKC", () => {
    const blob = encryptPinSettings({
      historyKey,
      userId,
      ...enabled,
      pin: "１２３４５６",
    });
    expect(decryptPinSettings({ historyKey, userId, blob }).pin).toBe("123456");
  });
  it("uses a fresh nonce for identical settings", () => {
    const input = { historyKey, userId, ...enabled };
    expect(encryptPinSettings(input)).not.toBe(encryptPinSettings(input));
  });
  it("keeps the packed blob at 553 bytes for every PIN state", () => {
    const blobs = [
      encryptPinSettings({
        historyKey,
        userId,
        enabled: true,
        pin: "123456",
        updatedAt: 1,
      }),
      encryptPinSettings({
        historyKey,
        userId,
        enabled: true,
        pin: "x".repeat(64),
        updatedAt: 1,
      }),
      encryptPinSettings({
        historyKey,
        userId,
        enabled: false,
        pin: "",
        updatedAt: 1,
      }),
    ];
    expect(blobs.map((blob) => base64ToBytes(blob).length)).toEqual([
      553, 553, 553,
    ]);
  });
  it("rejects a different user ID", () =>
    expectDecryptError(
      encryptPinSettings({ historyKey, userId, ...enabled }),
      historyKey,
      otherUserId,
    ));
  it("rejects a different history key", () =>
    expectDecryptError(
      encryptPinSettings({ historyKey, userId, ...enabled }),
      new Uint8Array(32).fill(8),
    ));
  it("does not open a contact book as PIN settings", () =>
    expectDecryptError(encryptContactBook({ historyKey, contacts: {} })));
  it("rejects damage to version, nonce, and ciphertext", () => {
    const packed = base64ToBytes(
      encryptPinSettings({ historyKey, userId, ...enabled }),
    );
    for (const index of [0, 1, 25, 26, packed.length - 1]) {
      const damaged = packed.slice();
      damaged[index] ^= 1;
      expectDecryptError(bytesToBase64(damaged));
    }
  });
  it("rejects a truncated blob", () =>
    expectDecryptError(
      bytesToBase64(
        base64ToBytes(
          encryptPinSettings({ historyKey, userId, ...enabled }),
        ).slice(0, -1),
      ),
    ));
  it("rejects non-base64 input", () => expectDecryptError("not base64!"));
  it("rejects blobs longer than 1024 base64 characters", () =>
    expectDecryptError("A".repeat(1025)));
  it("rejects PINs shorter than six characters", () =>
    expect(() =>
      encryptPinSettings({ historyKey, userId, ...enabled, pin: "12345" }),
    ).toThrow(TypeError));
  it("rejects PINs longer than 64 characters", () =>
    expect(() =>
      encryptPinSettings({
        historyKey,
        userId,
        ...enabled,
        pin: "x".repeat(65),
      }),
    ).toThrow(TypeError));
  it("rejects a nonempty PIN while disabled", () =>
    expect(() =>
      encryptPinSettings({
        historyKey,
        userId,
        enabled: false,
        pin: "123456",
        updatedAt: 1,
      }),
    ).toThrow(TypeError));
  it("rejects a nonboolean enabled value", () =>
    expect(() =>
      encryptPinSettings({
        historyKey,
        userId,
        enabled: 1 as unknown as boolean,
        pin: "123456",
        updatedAt: 1,
      }),
    ).toThrow(TypeError));
  it.each([-1, 1.5, Number.NaN])("rejects invalid updatedAt %s", (updatedAt) =>
    expect(() =>
      encryptPinSettings({ historyKey, userId, ...enabled, updatedAt }),
    ).toThrow(TypeError),
  );
  it("rejects an invalid user ID", () =>
    expect(() =>
      encryptPinSettings({ historyKey, userId: "z".repeat(64), ...enabled }),
    ).toThrow(TypeError));
  it("rejects an invalid history key length", () =>
    expect(() =>
      encryptPinSettings({
        historyKey: new Uint8Array(31),
        userId,
        ...enabled,
      }),
    ).toThrow(TypeError));
  it("rejects plaintext with nonzero padding", () =>
    expectDecryptError(
      forged(packedJson(JSON.stringify({ v: 1, ...enabled }), 1)),
    ));
  it("rejects plaintext with an extra JSON field", () =>
    expectDecryptError(
      forged(packedJson(JSON.stringify({ v: 1, ...enabled, extra: true }))),
    ));
  it("rejects a PIN that is not already NFKC", () =>
    expectDecryptError(
      forged(
        packedJson(
          JSON.stringify({
            v: 1,
            enabled: true,
            pin: "１２３４５６",
            updatedAt: 42,
          }),
        ),
      ),
    ));
  it("rejects an unsupported plaintext version", () =>
    expectDecryptError(
      forged(packedJson(JSON.stringify({ v: 2, ...enabled }))),
    ));
  it("rejects a decrypted payload that is not exactly 512 bytes", () => {
    const short = packedJson(JSON.stringify({ v: 1, ...enabled })).slice(
      0,
      511,
    );
    expectDecryptError(forged(short));
  });
  it("rejects contact-book blobs using the PIN settings decoder", () => {
    const blob = encryptContactBook({
      historyKey,
      contacts: { [userId]: "test" },
    });
    expect(() => decryptContactBook({ historyKey, blob })).not.toThrow();
    expectDecryptError(blob);
  });
});
