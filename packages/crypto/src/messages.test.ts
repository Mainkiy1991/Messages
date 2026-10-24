import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  DecryptError,
  decryptHistoryEntry,
  decryptContactBook,
  decryptTextMessage,
  deriveKeys,
  encryptHistoryEntry,
  encryptContactBook,
  encryptTextMessage,
  newClientMsgId,
} from "./index.js";

const alice = deriveKeys(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
const bob = deriveKeys(
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
);
const aliceId = bytesToHex(alice.identity.publicKey);
const bobId = bytesToHex(bob.identity.publicKey);
const sentAt = 1_700_000_000_000;
const contactKey = new Uint8Array(32).fill(7);
const contactId = "ab".repeat(32);

describe("encrypted contact books", () => {
  it("decrypts the fixed contact-book compatibility vector", () => {
    // НЕ МЕНЯТЬ: изменение формата сломает расшифровку сохранённых контактов
    const blob =
      "AQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCbgXix4P4PJLLOnCbynEK2BkKpV+4cJ2BZ104XAUIYsuxSBXfTvhDDIYY7z5Olbv73Yuo88YtFML2j99OZtYVwGuKjtO6ZBJ2ZDWIGbjZDldqHR4pmagCuEllL5DD9ZpfsNbXJLPpuhxy+RakI534A==";
    expect(decryptContactBook({ historyKey: contactKey, blob })).toEqual({
      [contactId]: "Alice",
    });
  });

  it("round-trips names and empty books with a fresh nonce", () => {
    const contacts = { [contactId]: " Алиса 🚀 ", [bobId]: "Bob" };
    const first = encryptContactBook({ historyKey: contactKey, contacts });
    const second = encryptContactBook({ historyKey: contactKey, contacts });
    expect(decryptContactBook({ historyKey: contactKey, blob: first })).toEqual(
      contacts,
    );
    expect(first).not.toBe(second);
    expect(
      decryptContactBook({
        historyKey: contactKey,
        blob: encryptContactBook({ historyKey: contactKey, contacts: {} }),
      }),
    ).toEqual({});
  });

  it("rejects corrupt blobs and invalid contact data", () => {
    const blob = encryptContactBook({
      historyKey: contactKey,
      contacts: { [contactId]: "Alice" },
    });
    const damaged = bytesToBase64(
      Uint8Array.from(base64ToBytes(blob), (byte, index) =>
        index === 2 ? byte ^ 1 : byte,
      ),
    );
    for (const invalid of [damaged, blob.slice(0, -4), "%%%="]) {
      expect(() =>
        decryptContactBook({ historyKey: contactKey, blob: invalid }),
      ).toThrow(DecryptError);
    }
    const wrongVersion = base64ToBytes(blob);
    wrongVersion[0] = 2;
    expect(() =>
      decryptContactBook({
        historyKey: contactKey,
        blob: bytesToBase64(wrongVersion),
      }),
    ).toThrow(DecryptError);
    expect(() =>
      decryptContactBook({ historyKey: new Uint8Array(32).fill(8), blob }),
    ).toThrow(DecryptError);
    expect(() =>
      encryptContactBook({
        historyKey: contactKey,
        contacts: { [contactId]: "  " },
      }),
    ).toThrow(TypeError);
    expect(() =>
      encryptContactBook({
        historyKey: contactKey,
        contacts: { [contactId]: "x".repeat(65) },
      }),
    ).toThrow(TypeError);
    expect(() =>
      encryptContactBook({
        historyKey: contactKey,
        contacts: { nope: "Alice" },
      }),
    ).toThrow(TypeError);
    expect(() =>
      encryptContactBook({
        historyKey: contactKey,
        contacts: Object.fromEntries(
          Array.from({ length: 1001 }, (_, i) => [
            `${i.toString(16).padStart(64, "0")}`,
            "A",
          ]),
        ),
      }),
    ).toThrow(TypeError);
  });
});

describe("base64 and message ids", () => {
  it("round-trips standard padded base64 and rejects malformed values", () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    for (const bad of ["a", "!!!!", "AA=A", "AB==", "AA==\n"]) {
      expect(() => base64ToBytes(bad)).toThrow(TypeError);
    }
  });

  it("creates a 32-character random hexadecimal client message id", () => {
    expect(newClientMsgId()).toMatch(/^[0-9a-f]{32}$/u);
  });
});

describe("strict identifier casing", () => {
  it("rejects uppercase user and client message identifiers", () => {
    expect(() =>
      encryptHistoryEntry({
        historyKey: alice.historyKey,
        clientMsgId: "A" + "0".repeat(31),
        peerId: bobId,
        text: "hello",
        sentAt,
      }),
    ).toThrow(TypeError);
    expect(() =>
      encryptHistoryEntry({
        historyKey: alice.historyKey,
        clientMsgId: "0".repeat(32),
        peerId: "A" + bobId.slice(1),
        text: "hello",
        sentAt,
      }),
    ).toThrow(TypeError);
  });
});

describe("recipient messages", () => {
  function encrypt(text: string, recipient = bob, sent = sentAt) {
    return encryptTextMessage({
      senderEncryptionPrivateKey: alice.encryption.privateKey,
      recipientEncryptionPublicKey: recipient.encryption.publicKey,
      senderId: aliceId,
      recipientId: recipient === bob ? bobId : aliceId,
      text,
      sentAt: sent,
    });
  }

  function decrypt(
    ciphertext: string,
    sender = alice,
    recipient = bob,
    from = aliceId,
    to = bobId,
  ) {
    return decryptTextMessage({
      recipientEncryptionPrivateKey: recipient.encryption.privateKey,
      senderEncryptionPublicKey: sender.encryption.publicKey,
      senderId: from,
      recipientId: to,
      ciphertext,
    });
  }

  it("round-trips Latin, Cyrillic, emoji, multiline and 4000-character messages", () => {
    for (const text of [
      "Hello",
      "Привет, мир",
      "Hi 👋🌍",
      "first\nsecond",
      "x".repeat(4000),
      "😀".repeat(4000),
    ]) {
      const ciphertext = encrypt(text);
      expect(decrypt(ciphertext)).toEqual({ text, sentAt });
      expect(ciphertext.length).toBeLessThan(64 * 1024);
    }
  });

  it("uses a fresh nonce for each encryption", () => {
    expect(encrypt("same text")).not.toBe(encrypt("same text"));
  });

  it("rejects wrong keys, tampering, identity substitution and invalid envelopes", () => {
    const ciphertext = encrypt("secret");
    expect(() =>
      decryptTextMessage({
        recipientEncryptionPrivateKey: alice.encryption.privateKey,
        senderEncryptionPublicKey: alice.encryption.publicKey,
        senderId: aliceId,
        recipientId: bobId,
        ciphertext,
      }),
    ).toThrow(DecryptError);
    const packed = base64ToBytes(ciphertext);
    for (const offset of [1, 25, packed.length - 1]) {
      const changed = packed.slice();
      changed[offset] ^= 1;
      expect(() => decrypt(bytesToBase64(changed))).toThrow(DecryptError);
    }
    expect(() =>
      decrypt(ciphertext, alice, bob, "f".repeat(64), bobId),
    ).toThrow(DecryptError);
    expect(() =>
      decrypt(ciphertext, alice, bob, aliceId, "f".repeat(64)),
    ).toThrow(DecryptError);
    for (const invalid of ["", "!", bytesToBase64(packed.slice(0, 10))]) {
      expect(() => decrypt(invalid)).toThrow(DecryptError);
    }
    const unknownVersion = packed.slice();
    unknownVersion[0] = 2;
    expect(() => decrypt(bytesToBase64(unknownVersion))).toThrow(DecryptError);
  });

  it("rejects zero and small-order public keys and invalid plaintext at encryption", () => {
    expect(() =>
      encryptTextMessage({
        senderEncryptionPrivateKey: alice.encryption.privateKey,
        recipientEncryptionPublicKey: new Uint8Array(32),
        senderId: aliceId,
        recipientId: bobId,
        text: "x",
      }),
    ).toThrow();
    const smallOrderPoint = new Uint8Array(32);
    smallOrderPoint[0] = 1;
    expect(() =>
      encryptTextMessage({
        senderEncryptionPrivateKey: alice.encryption.privateKey,
        recipientEncryptionPublicKey: smallOrderPoint,
        senderId: aliceId,
        recipientId: bobId,
        text: "x",
      }),
    ).toThrow();
    for (const text of ["", "   ", "x".repeat(4001), "😀".repeat(5000)]) {
      expect(() => encrypt(text)).toThrow();
    }
  });

  it("lets Alice and Bob exchange messages in both directions using derived keys", () => {
    const toBob = encryptTextMessage({
      senderEncryptionPrivateKey: alice.encryption.privateKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      senderId: aliceId,
      recipientId: bobId,
      text: "Alice to Bob",
      sentAt,
    });
    expect(
      decryptTextMessage({
        recipientEncryptionPrivateKey: bob.encryption.privateKey,
        senderEncryptionPublicKey: alice.encryption.publicKey,
        senderId: aliceId,
        recipientId: bobId,
        ciphertext: toBob,
      }).text,
    ).toBe("Alice to Bob");
    const toAlice = encryptTextMessage({
      senderEncryptionPrivateKey: bob.encryption.privateKey,
      recipientEncryptionPublicKey: alice.encryption.publicKey,
      senderId: bobId,
      recipientId: aliceId,
      text: "Bob to Alice",
      sentAt,
    });
    expect(
      decryptTextMessage({
        recipientEncryptionPrivateKey: alice.encryption.privateKey,
        senderEncryptionPublicKey: bob.encryption.publicKey,
        senderId: bobId,
        recipientId: aliceId,
        ciphertext: toAlice,
      }).text,
    ).toBe("Bob to Alice");
  });
});

describe("sender history entries", () => {
  const clientMsgId = "01".repeat(16);

  it("round-trips and binds the history key, message id and peer id", () => {
    const entry = encryptHistoryEntry({
      historyKey: alice.historyKey,
      clientMsgId,
      peerId: bobId,
      text: "history text",
      sentAt,
    });
    expect(
      decryptHistoryEntry({
        historyKey: alice.historyKey,
        clientMsgId,
        peerId: bobId,
        entry,
      }),
    ).toEqual({ text: "history text", sentAt });
    expect(() =>
      decryptHistoryEntry({
        historyKey: bob.historyKey,
        clientMsgId,
        peerId: bobId,
        entry,
      }),
    ).toThrow(DecryptError);
    expect(() =>
      decryptHistoryEntry({
        historyKey: alice.historyKey,
        clientMsgId: "02".repeat(16),
        peerId: bobId,
        entry,
      }),
    ).toThrow(DecryptError);
    expect(() =>
      decryptHistoryEntry({
        historyKey: alice.historyKey,
        clientMsgId,
        peerId: aliceId,
        entry,
      }),
    ).toThrow(DecryptError);
  });

  it("decrypts fixed compatibility vectors", () => {
    // НЕ МЕНЯТЬ: изменение формата сломает расшифровку уже сохранённых сообщений
    expect(
      decryptTextMessage({
        recipientEncryptionPrivateKey: bob.encryption.privateKey,
        senderEncryptionPublicKey: alice.encryption.publicKey,
        senderId: aliceId,
        recipientId: bobId,
        ciphertext:
          "AQICAgICAgICAgICAgICAgICAgICAgICAgeF2KPOnZtjgFOw3w6S1atAt23V1Swl41qiLEmNa16oSRlJ546e4gHvOOIaDBqDcVAtlbJhAb5xyeG/3VW7Ggo/Wf0N7IQQ5x1TZRM=",
      }),
    ).toEqual({ text: "Тест vector 👋", sentAt });
    expect(
      decryptHistoryEntry({
        historyKey: alice.historyKey,
        clientMsgId,
        peerId: bobId,
        entry:
          "AQMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA0gQ2LVLX0ZISjtniITtdIAyg+HM38K0SjQr9/8BXbYeMc0cZuf1UB0S7sYpBJdLyE+y54dqCLqstpzW76YNj1QvwR1UBHoapfcMoUI=",
      }),
    ).toEqual({ text: "Тест vector 👋", sentAt });
  });
});
