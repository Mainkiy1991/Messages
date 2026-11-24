import { describe, expect, it } from "vitest";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  DecryptError,
  decryptHistoryEntry,
  decryptContactBook,
  decryptContactBookFull,
  decryptTextMessage,
  deriveKeys,
  encryptHistoryEntry,
  encryptContactBook,
  CONTACT_BOOK_MAX_BYTES,
  encryptTextMessage,
  newClientMsgId,
  newReplayMessageId,
  MAX_EDIT_REV,
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
const legacyUnknownTypeFixtures = [
  {
    type: "edit",
    id: "EREREREREREREREREREREQ==",
    clientMsgId: "11111111111111111111111111111111",
    ciphertext:
      "AhERERERERERERERERERERGc2nPm60mI/r5fH0gPpkc8bbYRFdHwd1BipmagyiwpksDMvbgTySIkRCc8/+NpmI5Gd2/ZK+6ge79fu25LNwhk8mkEJWCGpP1jW2m0Dk40AooCTUiQ88fCA71nwv9DZZRevbl7+C9znDDAQKFLknbjLsZ7BDGXvcyypQHOdOlzJJqor/MDabTbjHBX9i1NRYup1dinnhC3+99E3nuUioGegBdwof09rZfQgj/LYrJTmx27ueYM",
    historyEntry:
      "AhERERERERERERERERERERFfBQO0jLpe478Nr73TkmhvGodc+x7uhVbunh3PYWO/6LMrsWlDLd3+j1wWfmHIuae2zBvM9XnDlryjGKtqWT2j1yYEj8SRpK83G9HewcA+9Ti+KXihb1PR3dctSi5q/kvZgK7MjRVrEQ8OvtB0B2inkMSrH1E7BjQEOLl8qdXiVj5Ptni5Qr/yAs7tbcZuRYH+57/Uz4VZRma3/6KXexdEEZQSnf3cH70XbR9NctOegmf0ZIsw",
  },
  {
    type: "delete_request",
    id: "IiIiIiIiIiIiIiIiIiIiIg==",
    clientMsgId: "22222222222222222222222222222222",
    ciphertext:
      "AiIiIiIiIiIiIiIiIiIiIiLdb1ZGReLo4ckiUz3lWKt/k3d+dSpAxl90Ph7XH0o1Yk5CN4opWAqrknQlXkobgqO52qoq2cySSZHIkcYSLAR2gIMASDwAbNBP2AjoiuPmLyXLo2nWnHe0VWqZaHLQ1+plZybV9/cOigQWqK2GsgRm89HZ+2jgpAWIIqklEX+2CberKkAWHSA8aMmPwzn50HIn4xBaHZeDXXBmgCb06JhRngg=",
    historyEntry:
      "AiIiIiIiIiIiIiIiIiIiIiJroes0Z5oZlO4OU1Y8tfM77H5SEDNNhfAYgY7jTOV7hyeFCHIF3q4iAo2ceapWALSX1mm8YEQvSoRqXSYLkj4XVIKzWyf11HjS1vadiYVM09JnpO3G/oYZIuXqgMUQRb399EwTbcfoHJRakX+D7/PT3cSy7vW5lsCIOLVUf+MrkwMPDWx/btwNNOQ9vQeZAObdiUaoImq0TSX6YInlAVuhKr8=",
  },
  {
    type: "delete_answer",
    id: "MzMzMzMzMzMzMzMzMzMzMw==",
    clientMsgId: "33333333333333333333333333333333",
    ciphertext:
      "AjMzMzMzMzMzMzMzMzMzMzPFcpJNdJg0pa8l2UvqKdccmPEGTlEFRpL9ejBcoZ7xxHI2157F/raIJ5krIEfarQLi4BQs7AxwTAFNVYoY3j/gQ3xRMTa9BE0pyI8MnFS3W+bq8UYJxlc+oPp1tFaUYSMq3WC7ykz5nQYqbQoDbX7a4sTNhNeZJdhhyp85DCpK/9acNj28mb/FiDQ9M7+kjpKgID2W8vK5TSwx3h0JpbOetG/oD6+5wZ2KPe/jLLxc",
    historyEntry:
      "AjMzMzMzMzMzMzMzMzMzMzNxKw9M4AwSirQiXKMFjq+QJakYQ6sFceLqGGs2usxGUiuxcZuktZMpJkMxcp+dNtPWDKzHuQc4LklYwy6KaDXNi2B5jwdD+vSFBil97EGoL69zq5RFrlOHAKcqTXkAFaGIHQbbGF41hUFhnXtirpx2tfck5UYgG89uNnsZ0aOIEcAEN4DhsOl+hE3SqXgw8czFO8MSkzBtsSCxg/IJR5RI6ZRe6c6CijizwDyjwxMY",
  },
] as const;

describe("encrypted contact books", () => {
  it("decrypts the fixed contact-book compatibility vector", () => {
    // НЕ МЕНЯТЬ: изменение формата сломает расшифровку сохранённых контактов
    const blob =
      "AQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCbgXix4P4PJLLOnCbynEK2BkKpV+4cJ2BZ104XAUIYsuxSBXfTvhDDIYY7z5Olbv73Yuo88YtFML2j99OZtYVwGuKjtO6ZBJ2ZDWIGbjZDldqHR4pmagCuEllL5DD9ZpfsNbXJLPpuhxy+RakI534A==";
    expect(decryptContactBook({ historyKey: contactKey, blob })).toEqual({
      [contactId]: "Alice",
    });
  });

  it("reads the compatibility vector with no notes", () => {
    const blob =
      "AQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCbgXix4P4PJLLOnCbynEK2BkKpV+4cJ2BZ104XAUIYsuxSBXfTvhDDIYY7z5Olbv73Yuo88YtFML2j99OZtYVwGuKjtO6ZBJ2ZDWIGbjZDldqHR4pmagCuEllL5DD9ZpfsNbXJLPpuhxy+RakI534A==";
    expect(decryptContactBookFull({ historyKey: contactKey, blob })).toEqual({
      contacts: { [contactId]: "Alice" },
      notes: {},
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

  it("round-trips notes and omits an empty notes field", () => {
    const contacts = { [contactId]: "Alice" };
    const notes = { [contactId]: "Friend 🚀" };
    const legacyShape = encryptContactBook({
      historyKey: contactKey,
      contacts,
    });
    const emptyNotesShape = encryptContactBook({
      historyKey: contactKey,
      contacts,
      notes: {},
    });
    const withNotes = encryptContactBook({
      historyKey: contactKey,
      contacts,
      notes,
    });
    expect(legacyShape).toHaveLength(emptyNotesShape.length);
    expect(withNotes.length).toBeGreaterThan(legacyShape.length);
    expect(
      decryptContactBookFull({ historyKey: contactKey, blob: withNotes }),
    ).toEqual({ contacts, notes });
    expect(new TextDecoder().decode(base64ToBytes(withNotes))).not.toContain(
      "Friend 🚀",
    );
  });

  it("validates notes on encryption, including Unicode code points", () => {
    const contacts = { [contactId]: "Alice" };
    for (const note of [
      "",
      "  ",
      "x".repeat(201),
      "line\nbreak",
      "bad\u0001",
    ]) {
      expect(() =>
        encryptContactBook({
          historyKey: contactKey,
          contacts,
          notes: { [contactId]: note },
        }),
      ).toThrow(TypeError);
    }
    expect(() =>
      encryptContactBook({
        historyKey: contactKey,
        contacts,
        notes: { nope: "note" },
      }),
    ).toThrow(TypeError);
    expect(() =>
      encryptContactBook({
        historyKey: contactKey,
        contacts,
        notes: { [contactId]: "😀".repeat(200) },
      }),
    ).not.toThrow();
  });

  it("enforces the plaintext contact book byte limit", () => {
    const under = Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [
        i.toString(16).padStart(64, "0"),
        "A",
      ]),
    );
    let noteLength = 200;
    let notesUnder = Object.fromEntries(
      Object.keys(under).map((id) => [id, "x".repeat(noteLength)]),
    );
    while (
      new TextEncoder().encode(
        JSON.stringify({ v: 1, contacts: under, notes: notesUnder }),
      ).length > CONTACT_BOOK_MAX_BYTES &&
      noteLength > 0
    ) {
      noteLength--;
      notesUnder = Object.fromEntries(
        Object.keys(under).map((id) => [id, "x".repeat(noteLength)]),
      );
    }
    expect(() =>
      encryptContactBook({
        historyKey: contactKey,
        contacts: under,
        notes: notesUnder,
      }),
    ).not.toThrow();
    expect(() =>
      encryptContactBook({
        historyKey: contactKey,
        contacts: under,
        notes: Object.fromEntries(
          Object.keys(under).map((id) => [id, "x".repeat(noteLength + 1)]),
        ),
      }),
    ).toThrow(RangeError);
    const notesOver = Object.fromEntries(
      Object.keys(under).map((id) => [id, "x".repeat(200)]),
    );
    expect(() =>
      encryptContactBook({
        historyKey: contactKey,
        contacts: under,
        notes: notesOver,
      }),
    ).toThrow(RangeError);
    expect(CONTACT_BOOK_MAX_BYTES).toBe(200 * 1024);
  });

  it("drops notes for missing contacts and rejects malformed encrypted notes", () => {
    const info = new TextEncoder().encode("messages/v1/contacts");
    const salt = new Uint8Array(32);
    const key = hkdf(sha256, contactKey, salt, info, 32);
    const nonce = new Uint8Array(24).fill(9);
    const createBlob = (notes: unknown) => {
      const plaintext = new TextEncoder().encode(
        JSON.stringify({ v: 1, contacts: { [contactId]: "Alice" }, notes }),
      );
      const ciphertext = xchacha20poly1305(key, nonce, info).encrypt(plaintext);
      return bytesToBase64(Uint8Array.from([1, ...nonce, ...ciphertext]));
    };
    expect(
      decryptContactBookFull({
        historyKey: contactKey,
        blob: createBlob({ ["cd".repeat(32)]: "orphan", [contactId]: "note" }),
      }).notes,
    ).toEqual({ [contactId]: "note" });
    for (const malformed of [123, "x".repeat(201), "bad\u0001", "  "]) {
      expect(() =>
        decryptContactBookFull({
          historyKey: contactKey,
          blob: createBlob({ [contactId]: malformed }),
        }),
      ).toThrow(DecryptError);
    }
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
        senderId: aliceId,
        peerId: bobId,
        text: "hello",
        sentAt,
      }),
    ).toThrow(TypeError);
    expect(() =>
      encryptHistoryEntry({
        historyKey: alice.historyKey,
        clientMsgId: "0".repeat(32),
        senderId: aliceId,
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
      expect(decrypt(ciphertext)).toMatchObject({
        v: 2,
        type: "text",
        text,
        sentAt,
      });
      expect(ciphertext.length).toBeLessThan(64 * 1024);
    }
  });

  it("uses a fresh nonce for each encryption", () => {
    expect(encrypt("same text")).not.toBe(encrypt("same text"));
  });

  it("authenticates the v2 ID in both the envelope and AAD", () => {
    const ciphertext = encrypt("bound ID");
    const packed = base64ToBytes(ciphertext);
    packed[1] ^= 1;
    expect(() => decrypt(bytesToBase64(packed))).toThrow(DecryptError);
    const changedSentAt = base64ToBytes(ciphertext);
    changedSentAt[changedSentAt.length - 18] ^= 1;
    expect(() => decrypt(bytesToBase64(changedSentAt))).toThrow(
      "DECRYPT_FAILED",
    );
  });

  it("rejects altered v2 sentAt with DECRYPT_FAILED", () => {
    const packed = base64ToBytes(encrypt("timestamp"));
    packed[packed.length - 18] ^= 1;
    expect(() => decrypt(bytesToBase64(packed))).toThrow("DECRYPT_FAILED");
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
    ).toThrow("DECRYPT_FAILED");
    const packed = base64ToBytes(ciphertext);
    for (const offset of [1, 25, packed.length - 1]) {
      const changed = packed.slice();
      changed[offset] ^= 1;
      expect(() => decrypt(bytesToBase64(changed))).toThrow(DecryptError);
    }
    expect(() =>
      decrypt(ciphertext, alice, bob, "f".repeat(64), bobId),
    ).toThrow("DECRYPT_FAILED");
    expect(() =>
      decrypt(ciphertext, alice, bob, aliceId, "f".repeat(64)),
    ).toThrow("DECRYPT_FAILED");
    for (const invalid of ["", "!", bytesToBase64(packed.slice(0, 10))]) {
      expect(() => decrypt(invalid)).toThrow(DecryptError);
    }
    const unknownVersion = packed.slice();
    unknownVersion[0] = 3;
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

  it("decrypts legacy protocol messages as unknown types", () => {
    for (const fixture of legacyUnknownTypeFixtures) {
      expect(
        decryptTextMessage({
          recipientEncryptionPrivateKey: bob.encryption.privateKey,
          senderEncryptionPublicKey: alice.encryption.publicKey,
          senderId: aliceId,
          recipientId: bobId,
          ciphertext: fixture.ciphertext,
        }),
      ).toEqual({
        v: 2,
        id: fixture.id,
        type: fixture.type,
        sentAt,
      });
    }
  });
});

describe("sender history entries", () => {
  const clientMsgId = "01".repeat(16);

  it("round-trips and binds the history key, participants and both message IDs", () => {
    const entry = encryptHistoryEntry({
      historyKey: alice.historyKey,
      clientMsgId,
      senderId: aliceId,
      peerId: bobId,
      text: "history text",
      sentAt,
    });
    expect(
      decryptHistoryEntry({
        historyKey: alice.historyKey,
        clientMsgId,
        senderId: aliceId,
        peerId: bobId,
        entry,
      }),
    ).toMatchObject({
      v: 2,
      type: "text",
      text: "history text",
      sentAt,
    });
    expect(() =>
      decryptHistoryEntry({
        historyKey: bob.historyKey,
        clientMsgId,
        senderId: aliceId,
        peerId: bobId,
        entry,
      }),
    ).toThrow("DECRYPT_FAILED");
    expect(() =>
      decryptHistoryEntry({
        historyKey: alice.historyKey,
        clientMsgId: "02".repeat(16),
        senderId: aliceId,
        peerId: bobId,
        entry,
      }),
    ).toThrow(DecryptError);
    expect(() =>
      decryptHistoryEntry({
        historyKey: alice.historyKey,
        clientMsgId,
        senderId: aliceId,
        peerId: aliceId,
        entry,
      }),
    ).toThrow(DecryptError);
    expect(() =>
      decryptHistoryEntry({
        historyKey: alice.historyKey,
        clientMsgId,
        senderId: "f".repeat(64),
        peerId: bobId,
        entry,
      }),
    ).toThrow(DecryptError);
    const changedSentAt = base64ToBytes(entry);
    changedSentAt[changedSentAt.length - 18] ^= 1;
    expect(() =>
      decryptHistoryEntry({
        historyKey: alice.historyKey,
        clientMsgId,
        senderId: aliceId,
        peerId: bobId,
        entry: bytesToBase64(changedSentAt),
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
        senderId: aliceId,
        peerId: bobId,
        entry:
          "AQMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA0gQ2LVLX0ZISjtniITtdIAyg+HM38K0SjQr9/8BXbYeMc0cZuf1UB0S7sYpBJdLyE+y54dqCLqstpzW76YNj1QvwR1UBHoapfcMoUI=",
      }),
    ).toEqual({ text: "Тест vector 👋", sentAt });
  });

  it("decrypts legacy history entries as unknown types", () => {
    for (const fixture of legacyUnknownTypeFixtures) {
      expect(
        decryptHistoryEntry({
          historyKey: alice.historyKey,
          clientMsgId: fixture.clientMsgId,
          senderId: aliceId,
          peerId: bobId,
          entry: fixture.historyEntry,
        }),
      ).toEqual({
        v: 2,
        id: fixture.id,
        type: fixture.type,
        sentAt,
      });
    }
  });
});

describe("in-place message edits", () => {
  const messageId = newReplayMessageId();
  const clientMsgId = newClientMsgId();

  function text(rev?: number) {
    return rev === undefined ? "Оригинал" : `Правка ${rev}`;
  }

  function encrypt(rev?: number, id = messageId) {
    const input = {
      senderEncryptionPrivateKey: alice.encryption.privateKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      senderId: aliceId,
      recipientId: bobId,
      text: text(rev),
      sentAt,
      messageId: id,
    };
    return rev === undefined
      ? encryptTextMessage(input)
      : encryptTextMessage({ ...input, rev });
  }

  function encryptCopy(rev?: number, id = messageId) {
    const input = {
      historyKey: alice.historyKey,
      clientMsgId,
      senderId: aliceId,
      peerId: bobId,
      text: text(rev),
      sentAt,
      messageId: id,
    };
    return rev === undefined
      ? encryptHistoryEntry(input)
      : encryptHistoryEntry({ ...input, rev });
  }

  function decrypt(ciphertext: string) {
    return decryptTextMessage({
      recipientEncryptionPrivateKey: bob.encryption.privateKey,
      senderEncryptionPublicKey: alice.encryption.publicKey,
      senderId: aliceId,
      recipientId: bobId,
      ciphertext,
    });
  }

  function decryptCopy(entry: string) {
    return decryptHistoryEntry({
      historyKey: alice.historyKey,
      clientMsgId,
      senderId: aliceId,
      peerId: bobId,
      entry,
    });
  }

  function nonceOf(packed: string) {
    return bytesToBase64(base64ToBytes(packed).subarray(17, 41));
  }

  it("round-trips a text message with an edit revision to the recipient", () => {
    expect(decrypt(encrypt(4))).toEqual({
      v: 2,
      id: messageId,
      type: "text",
      text: "Правка 4",
      sentAt,
      rev: 4,
    });
  });

  it("round-trips a history entry with an edit revision for the author", () => {
    expect(decryptCopy(encryptCopy(2))).toEqual({
      v: 2,
      id: messageId,
      type: "text",
      text: "Правка 2",
      sentAt,
      rev: 2,
    });
  });

  it("keeps the payload and result unchanged without a revision", () => {
    const decrypted = decrypt(encrypt());
    expect(decrypted).toEqual({
      v: 2,
      id: messageId,
      type: "text",
      text: "Оригинал",
      sentAt,
    });
    expect("rev" in decrypted).toBe(false);
    const copy = decryptCopy(encryptCopy());
    expect(copy).toEqual({
      v: 2,
      id: messageId,
      type: "text",
      text: "Оригинал",
      sentAt,
    });
    expect("rev" in copy).toBe(false);
  });

  it("accepts the boundary revisions 1 and 100", () => {
    for (const rev of [1, MAX_EDIT_REV]) {
      expect(decrypt(encrypt(rev))).toMatchObject({ rev, id: messageId });
      expect(decryptCopy(encryptCopy(rev))).toMatchObject({
        rev,
        id: messageId,
      });
    }
  });

  it("rejects invalid revisions in text messages before sending", () => {
    for (const rev of [0, 101, 1.5, -1, "1" as unknown as number]) {
      expect(() => encrypt(rev)).toThrow(TypeError);
    }
  });

  it("rejects invalid revisions in history entries before sending", () => {
    for (const rev of [0, 101, 1.5, -1, "1" as unknown as number]) {
      expect(() => encryptCopy(rev)).toThrow(TypeError);
    }
  });

  it("encrypts an original and an edit of one message id with fresh nonces", () => {
    const original = encrypt();
    const edit = encrypt(5);
    expect(nonceOf(original)).not.toBe(nonceOf(edit));
    expect(original).not.toBe(edit);
    expect(decrypt(original)).toMatchObject({
      id: messageId,
      type: "text",
      text: "Оригинал",
    });
    expect(decrypt(edit)).toMatchObject({
      id: messageId,
      type: "text",
      text: "Правка 5",
      rev: 5,
    });
    const copyOriginal = encryptCopy();
    const copyEdit = encryptCopy(5);
    expect(nonceOf(copyOriginal)).not.toBe(nonceOf(copyEdit));
    expect(copyOriginal).not.toBe(copyEdit);
    expect(decryptCopy(copyOriginal)).toMatchObject({ id: messageId });
    expect(decryptCopy(copyEdit)).toMatchObject({ id: messageId, rev: 5 });
  });

  it("rejects a text edit whose envelope id was replaced", () => {
    const ciphertext = encrypt(3);
    expect(decrypt(ciphertext)).toMatchObject({ id: messageId, rev: 3 });
    const packed = base64ToBytes(ciphertext);
    packed[1] ^= 1;
    expect(() => decrypt(bytesToBase64(packed))).toThrow(DecryptError);
  });

  it("rejects a history edit whose envelope id was replaced", () => {
    const entry = encryptCopy(3);
    expect(decryptCopy(entry)).toMatchObject({ id: messageId, rev: 3 });
    const packed = base64ToBytes(entry);
    packed[1] ^= 1;
    expect(() => decryptCopy(bytesToBase64(packed))).toThrow(DecryptError);
  });
});
