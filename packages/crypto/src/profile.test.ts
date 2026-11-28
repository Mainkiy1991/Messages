import { x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
  DecryptError,
  PROFILE_ABOUT_MAX_CHARS,
  PROFILE_BLOB_MAX_LENGTH,
  PROFILE_NAME_MAX_CHARS,
  PROFILE_WRAP_MAX_LENGTH,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  decryptContactBookFull,
  decryptProfile,
  decryptTextMessage,
  deriveKeys,
  deriveProfileKey,
  encryptContactBook,
  encryptProfile,
  encryptTextMessage,
  unwrapProfileKey,
  wrapProfileKey,
} from "./index.js";

const alice = deriveKeys(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
const bob = deriveKeys(
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
);
const carol = deriveKeys(
  "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
);
const aid = bytesToHex(alice.encryption.publicKey);
const bid = bytesToHex(bob.encryption.publicKey);
const cid = bytesToHex(carol.encryption.publicKey);
const key = deriveProfileKey(alice.historyKey);
const contacts = { [bid]: "Боб" };
const profileAad = new TextEncoder().encode(`messages/v1/profile\n${aid}`);
const salt = new Uint8Array(32);
const enc = new TextEncoder();

function manualProfile(value: unknown): string {
  const nonce = new Uint8Array(24).fill(9);
  return bytesToBase64(
    new Uint8Array([
      1,
      ...nonce,
      ...xchacha20poly1305(key, nonce, profileAad).encrypt(
        enc.encode(JSON.stringify(value)),
      ),
    ]),
  );
}

function manualWrap(clear: Uint8Array): string {
  const shared = x25519.getSharedSecret(
    alice.encryption.privateKey,
    bob.encryption.publicKey,
  );
  const wrapKey = hkdf(
    sha256,
    shared,
    salt,
    new Uint8Array([
      ...enc.encode("messages/v1/profile-wrap"),
      ...alice.encryption.publicKey,
      ...bob.encryption.publicKey,
    ]),
    32,
  );
  const aad = enc.encode(
    `messages/v1/profile-wrap\n${aid}\n${bid}\n${bytesToHex(alice.encryption.publicKey)}\n${bytesToHex(bob.encryption.publicKey)}`,
  );
  const nonce = new Uint8Array(24).fill(8);
  return bytesToBase64(
    new Uint8Array([
      1,
      ...nonce,
      ...xchacha20poly1305(wrapKey, nonce, aad).encrypt(clear),
    ]),
  );
}

describe("profile key derivation", () => {
  it("is 32 bytes, deterministic and domain separated", () => {
    expect(key).toHaveLength(32);
    expect(deriveProfileKey(alice.historyKey)).toEqual(key);
    expect(key).not.toEqual(alice.historyKey);
    expect(deriveProfileKey(bob.historyKey)).not.toEqual(key);
    const profile = encryptProfile({
      profileKey: key,
      ownerId: aid,
      name: "Алиса",
    });
    expect(() =>
      decryptContactBookFull({ historyKey: alice.historyKey, blob: profile }),
    ).toThrow(DecryptError);
    const book = encryptContactBook({ historyKey: alice.historyKey, contacts });
    expect(() =>
      decryptProfile({ profileKey: key, ownerId: aid, blob: book }),
    ).toThrow(DecryptError);
    expect(() => deriveProfileKey(new Uint8Array(31))).toThrow(TypeError);
  });
});

describe("profile encryption", () => {
  it("round trips trimmed Unicode fields and defaults about", () => {
    expect(
      decryptProfile({
        profileKey: key,
        ownerId: aid,
        blob: encryptProfile({
          profileKey: key,
          ownerId: aid,
          name: "  Алиса 😀  ",
          about: "  Привет 👋  ",
        }),
      }),
    ).toEqual({ name: "Алиса 😀", about: "Привет 👋" });
    expect(
      decryptProfile({
        profileKey: key,
        ownerId: aid,
        blob: encryptProfile({ profileKey: key, ownerId: aid, name: "Алиса" }),
      }),
    ).toEqual({ name: "Алиса", about: "" });
    expect(
      decryptProfile({
        profileKey: key,
        ownerId: aid,
        blob: encryptProfile({
          profileKey: key,
          ownerId: aid,
          name: "Алиса",
          about: "   ",
        }),
      }).about,
    ).toBe("");
  });

  it("counts Unicode code points at the field limits", () => {
    expect(() =>
      encryptProfile({
        profileKey: key,
        ownerId: aid,
        name: "😀".repeat(PROFILE_NAME_MAX_CHARS),
      }),
    ).not.toThrow();
    expect(() =>
      encryptProfile({
        profileKey: key,
        ownerId: aid,
        name: "😀".repeat(PROFILE_NAME_MAX_CHARS + 1),
      }),
    ).toThrow(TypeError);
    expect(() =>
      encryptProfile({
        profileKey: key,
        ownerId: aid,
        name: "A",
        about: "😀".repeat(PROFILE_ABOUT_MAX_CHARS),
      }),
    ).not.toThrow();
    expect(() =>
      encryptProfile({
        profileKey: key,
        ownerId: aid,
        name: "A",
        about: "😀".repeat(PROFILE_ABOUT_MAX_CHARS + 1),
      }),
    ).toThrow(TypeError);
    expect(() =>
      encryptProfile({ profileKey: key, ownerId: aid, name: "" }),
    ).toThrow(TypeError);
    expect(() =>
      encryptProfile({ profileKey: key, ownerId: aid, name: "   " }),
    ).toThrow(TypeError);
  });

  it.each(["\n", "\u0000", "\t", "\u202e", "\u200b", "\ufeff", "\u2066"])(
    "rejects forbidden character %j in both fields",
    (char) => {
      expect(() =>
        encryptProfile({ profileKey: key, ownerId: aid, name: `A${char}` }),
      ).toThrow(TypeError);
      expect(() =>
        encryptProfile({
          profileKey: key,
          ownerId: aid,
          name: "A",
          about: `x${char}`,
        }),
      ).toThrow(TypeError);
    },
  );

  it("accepts ordinary punctuation and emoji", () => {
    expect(() =>
      encryptProfile({
        profileKey: key,
        ownerId: aid,
        name: "Jean-Luc O’Neil 😀",
        about: "Fine.",
      }),
    ).not.toThrow();
  });

  it.each([
    [
      "wrong key",
      { profileKey: deriveProfileKey(bob.historyKey), ownerId: aid },
    ],
    ["wrong owner AAD", { profileKey: key, ownerId: bid }],
  ])("rejects %s", (_reason, args) => {
    const blob = encryptProfile({
      profileKey: key,
      ownerId: aid,
      name: "Алиса",
    });
    expect(() => decryptProfile({ ...args, blob })).toThrow(DecryptError);
  });

  it("rejects corrupted, truncated, invalid, wrong-version and oversized blobs", () => {
    const blob = encryptProfile({
      profileKey: key,
      ownerId: aid,
      name: "Алиса",
    });
    const packed = base64ToBytes(blob);
    packed[packed.length - 1] ^= 1;
    const badVersion = base64ToBytes(blob);
    badVersion[0] = 7;
    for (const invalid of [
      bytesToBase64(packed),
      bytesToBase64(base64ToBytes(blob).slice(0, -1)),
      "!",
      bytesToBase64(badVersion),
      "A".repeat(PROFILE_BLOB_MAX_LENGTH + 4),
    ]) {
      expect(() =>
        decryptProfile({ profileKey: key, ownerId: aid, blob: invalid }),
      ).toThrow(DecryptError);
    }
  });

  it("accepts correctly authenticated profile structure", () => {
    expect(
      decryptProfile({
        profileKey: key,
        ownerId: aid,
        blob: manualProfile({ v: 1, name: "Ок", about: "Да" }),
      }),
    ).toEqual({ name: "Ок", about: "Да" });
  });

  it.each([
    ["name is numeric", { v: 1, name: 4, about: "" }],
    ["about is absent", { v: 1, name: "A" }],
    ["version is unknown", { v: 2, name: "A", about: "" }],
    [
      "an extra field is present",
      { v: 1, name: "A", about: "", type: "profile" },
    ],
    ["name is blank", { v: 1, name: "  ", about: "" }],
    ["name has bidi control", { v: 1, name: "A\u202e", about: "" }],
    ["plaintext is not an object", [1, "A", ""]],
  ])("rejects authenticated structure when %s", (_reason, value) => {
    expect(() =>
      decryptProfile({
        profileKey: key,
        ownerId: aid,
        blob: manualProfile(value),
      }),
    ).toThrow(DecryptError);
  });

  it("keeps maximum profile and fresh nonces within the blob limit", () => {
    const input = {
      profileKey: key,
      ownerId: aid,
      name: "😀".repeat(64),
      about: "😀".repeat(200),
    };
    const first = encryptProfile(input);
    const second = encryptProfile(input);
    expect(first.length).toBeLessThanOrEqual(PROFILE_BLOB_MAX_LENGTH);
    expect(first).not.toBe(second);
  });
});

describe("profile key wraps", () => {
  it("round trips from Alice to Bob and lets Bob decrypt Alice's profile", () => {
    const wrap = wrapProfileKey({
      ownerEncryptionPrivateKey: alice.encryption.privateKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      ownerId: aid,
      recipientId: bid,
      profileKey: key,
    });
    const received = unwrapProfileKey({
      recipientEncryptionPrivateKey: bob.encryption.privateKey,
      ownerEncryptionPublicKey: alice.encryption.publicKey,
      ownerId: aid,
      recipientId: bid,
      wrap,
    });
    expect(received).toEqual(key);
    const blob = encryptProfile({
      profileKey: key,
      ownerId: aid,
      name: "Алиса",
      about: "Здесь",
    });
    expect(
      decryptProfile({ profileKey: received, ownerId: aid, blob }),
    ).toEqual({ name: "Алиса", about: "Здесь" });
  });

  it("rejects altered peer identities and key, ciphertext, encoding or size", () => {
    const wrap = wrapProfileKey({
      ownerEncryptionPrivateKey: alice.encryption.privateKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      ownerId: aid,
      recipientId: bid,
      profileKey: key,
    });
    const packed = base64ToBytes(wrap);
    packed[packed.length - 1] ^= 1;
    const cases = [
      {
        recipientEncryptionPrivateKey: carol.encryption.privateKey,
        ownerEncryptionPublicKey: alice.encryption.publicKey,
        ownerId: aid,
        recipientId: bid,
        wrap,
      },
      {
        recipientEncryptionPrivateKey: bob.encryption.privateKey,
        ownerEncryptionPublicKey: alice.encryption.publicKey,
        ownerId: cid,
        recipientId: bid,
        wrap,
      },
      {
        recipientEncryptionPrivateKey: bob.encryption.privateKey,
        ownerEncryptionPublicKey: alice.encryption.publicKey,
        ownerId: aid,
        recipientId: cid,
        wrap,
      },
      {
        recipientEncryptionPrivateKey: bob.encryption.privateKey,
        ownerEncryptionPublicKey: carol.encryption.publicKey,
        ownerId: aid,
        recipientId: bid,
        wrap,
      },
      {
        recipientEncryptionPrivateKey: bob.encryption.privateKey,
        ownerEncryptionPublicKey: alice.encryption.publicKey,
        ownerId: aid,
        recipientId: bid,
        wrap: bytesToBase64(packed),
      },
      {
        recipientEncryptionPrivateKey: bob.encryption.privateKey,
        ownerEncryptionPublicKey: alice.encryption.publicKey,
        ownerId: aid,
        recipientId: bid,
        wrap: bytesToBase64(base64ToBytes(wrap).slice(0, -1)),
      },
      {
        recipientEncryptionPrivateKey: bob.encryption.privateKey,
        ownerEncryptionPublicKey: alice.encryption.publicKey,
        ownerId: aid,
        recipientId: bid,
        wrap: "!",
      },
      {
        recipientEncryptionPrivateKey: bob.encryption.privateKey,
        ownerEncryptionPublicKey: alice.encryption.publicKey,
        ownerId: aid,
        recipientId: bid,
        wrap: "A".repeat(PROFILE_WRAP_MAX_LENGTH + 4),
      },
    ];
    for (const input of cases)
      expect(() => unwrapProfileKey(input)).toThrow(DecryptError);
  });

  it("accepts a valid authenticated wrap and rejects a non-32-byte plaintext", () => {
    expect(
      unwrapProfileKey({
        recipientEncryptionPrivateKey: bob.encryption.privateKey,
        ownerEncryptionPublicKey: alice.encryption.publicKey,
        ownerId: aid,
        recipientId: bid,
        wrap: manualWrap(key),
      }),
    ).toEqual(key);
    expect(() =>
      unwrapProfileKey({
        recipientEncryptionPrivateKey: bob.encryption.privateKey,
        ownerEncryptionPublicKey: alice.encryption.publicKey,
        ownerId: aid,
        recipientId: bid,
        wrap: manualWrap(new Uint8Array(31)),
      }),
    ).toThrow(DecryptError);
  });

  it("rejects zero shared secrets on both sides", () => {
    expect(() =>
      wrapProfileKey({
        ownerEncryptionPrivateKey: alice.encryption.privateKey,
        recipientEncryptionPublicKey: new Uint8Array(32),
        ownerId: aid,
        recipientId: bid,
        profileKey: key,
      }),
    ).toThrow(TypeError);
    expect(() =>
      unwrapProfileKey({
        recipientEncryptionPrivateKey: bob.encryption.privateKey,
        ownerEncryptionPublicKey: new Uint8Array(32),
        ownerId: aid,
        recipientId: bid,
        wrap: manualWrap(key),
      }),
    ).toThrow(DecryptError);
  });

  it("limits wraps, uses fresh nonces, and separates message envelopes", () => {
    const input = {
      ownerEncryptionPrivateKey: alice.encryption.privateKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      ownerId: aid,
      recipientId: bid,
      profileKey: key,
    };
    const first = wrapProfileKey(input),
      second = wrapProfileKey(input);
    expect(first.length).toBeLessThanOrEqual(PROFILE_WRAP_MAX_LENGTH);
    expect(first).not.toBe(second);
    const message = encryptTextMessage({
      senderEncryptionPrivateKey: alice.encryption.privateKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      senderId: aid,
      recipientId: bid,
      text: "hi",
    });
    expect(() =>
      unwrapProfileKey({
        recipientEncryptionPrivateKey: bob.encryption.privateKey,
        ownerEncryptionPublicKey: alice.encryption.publicKey,
        ownerId: aid,
        recipientId: bid,
        wrap: message,
      }),
    ).toThrow(DecryptError);
    expect(() =>
      decryptTextMessage({
        recipientEncryptionPrivateKey: bob.encryption.privateKey,
        senderEncryptionPublicKey: alice.encryption.publicKey,
        senderId: aid,
        recipientId: bid,
        ciphertext: first,
      }),
    ).toThrow(DecryptError);
  });
});
