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
  encryptEditMessage,
  encryptHistoryEditEntry,
  encryptHistoryDeleteAnswerEntry,
  encryptHistoryDeleteRequestEntry,
  encryptDeleteAnswerMessage,
  encryptDeleteRequestMessage,
  encryptHistoryEntry,
  encryptContactBook,
  encryptTextMessage,
  newClientMsgId,
  newReplayMessageId,
  parseDeleteAnswerPayload,
  parseDeleteRequestPayload,
  parseEditPayload,
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
});

describe("message edits", () => {
  const target = newReplayMessageId();
  const clientMsgId = "03".repeat(16);

  function encryptEdit(text: string, rev = 3) {
    return encryptEditMessage({
      senderEncryptionPrivateKey: alice.encryption.privateKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      senderId: aliceId,
      recipientId: bobId,
      target,
      rev,
      text,
      sentAt,
    });
  }

  it("round-trips an edit through the message and history envelopes", () => {
    expect(
      decryptTextMessage({
        recipientEncryptionPrivateKey: bob.encryption.privateKey,
        senderEncryptionPublicKey: alice.encryption.publicKey,
        senderId: aliceId,
        recipientId: bobId,
        ciphertext: encryptEdit("Отредактировано 🚀"),
      }),
    ).toMatchObject({
      v: 2,
      type: "edit",
      target,
      rev: 3,
      text: "Отредактировано 🚀",
      sentAt,
    });
    expect(
      decryptHistoryEntry({
        historyKey: alice.historyKey,
        clientMsgId,
        senderId: aliceId,
        peerId: bobId,
        entry: encryptHistoryEditEntry({
          historyKey: alice.historyKey,
          clientMsgId,
          senderId: aliceId,
          peerId: bobId,
          target,
          rev: 3,
          text: "Отредактировано 🚀",
          sentAt,
        }),
      }),
    ).toMatchObject({
      v: 2,
      type: "edit",
      target,
      rev: 3,
      text: "Отредактировано 🚀",
      sentAt,
    });
  });

  it("binds an edit to the same participants, IDs and history entry", () => {
    const ciphertext = encryptEdit("bound");
    for (const participant of [
      { senderId: bobId, recipientId: aliceId },
      { senderId: aliceId, recipientId: aliceId },
    ]) {
      expect(() =>
        decryptTextMessage({
          recipientEncryptionPrivateKey: bob.encryption.privateKey,
          senderEncryptionPublicKey: alice.encryption.publicKey,
          ciphertext,
          ...participant,
        }),
      ).toThrow(DecryptError);
    }
    const entry = encryptHistoryEditEntry({
      historyKey: alice.historyKey,
      clientMsgId,
      senderId: aliceId,
      peerId: bobId,
      target,
      rev: 1,
      text: "bound",
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
    ).toThrow(DecryptError);
    expect(() =>
      decryptHistoryEntry({
        historyKey: alice.historyKey,
        clientMsgId: "04".repeat(16),
        senderId: aliceId,
        peerId: bobId,
        entry,
      }),
    ).toThrow(DecryptError);
  });

  it("skips malformed edit payloads like unknown message types", () => {
    expect(parseEditPayload({ target, rev: 1, text: "ok" })).toEqual({
      target,
      rev: 1,
      text: "ok",
    });
    for (const invalid of [
      null,
      "edit",
      { rev: 1, text: "ok" },
      { target, rev: 1 },
      { target: "bad", rev: 1, text: "ok" },
      { target: "ab".repeat(16), rev: 1, text: "ok" },
      { target, rev: 0, text: "ok" },
      { target, rev: 101, text: "ok" },
      { target, rev: 1.5, text: "ok" },
      { target, rev: "1", text: "ok" },
      { target, rev: 1, text: "   " },
      { target, rev: 1, text: "x".repeat(4001) },
    ])
      expect(parseEditPayload(invalid)).toBeNull();
  });

  it("rejects invalid edit input before sending", () => {
    const base = {
      senderEncryptionPrivateKey: alice.encryption.privateKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      senderId: aliceId,
      recipientId: bobId,
      target,
      rev: 1,
      text: "ok",
      sentAt,
    };
    expect(() => encryptEditMessage({ ...base, target: "bad" })).toThrow(
      TypeError,
    );
    expect(() => encryptEditMessage({ ...base, rev: 0 })).toThrow(TypeError);
    expect(() => encryptEditMessage({ ...base, rev: 101 })).toThrow(TypeError);
    expect(() => encryptEditMessage({ ...base, rev: 2.5 })).toThrow(TypeError);
    expect(() => encryptEditMessage({ ...base, text: "  " })).toThrow(
      TypeError,
    );
    expect(() =>
      encryptEditMessage({ ...base, text: "x".repeat(4001) }),
    ).toThrow(TypeError);
    const historyBase = {
      historyKey: alice.historyKey,
      clientMsgId,
      senderId: aliceId,
      peerId: bobId,
      target,
      rev: 1,
      text: "ok",
      sentAt,
    };
    expect(() =>
      encryptHistoryEditEntry({ ...historyBase, target: "bad" }),
    ).toThrow(TypeError);
    expect(() => encryptHistoryEditEntry({ ...historyBase, rev: 101 })).toThrow(
      TypeError,
    );
  });
});

describe("message delete requests", () => {
  const target = newReplayMessageId();
  const clientMsgId = "0a".repeat(16);

  const encryptRequest = () =>
    encryptDeleteRequestMessage({
      senderEncryptionPrivateKey: alice.encryption.privateKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      senderId: aliceId,
      recipientId: bobId,
      target,
      sentAt,
    });
  const encryptAnswer = (accept: boolean) =>
    encryptDeleteAnswerMessage({
      senderEncryptionPrivateKey: bob.encryption.privateKey,
      recipientEncryptionPublicKey: alice.encryption.publicKey,
      senderId: bobId,
      recipientId: aliceId,
      target,
      accept,
      sentAt,
    });
  const historyRequest = () =>
    encryptHistoryDeleteRequestEntry({
      historyKey: alice.historyKey,
      clientMsgId,
      senderId: aliceId,
      peerId: bobId,
      target,
      sentAt,
    });
  const historyAnswer = (accept: boolean) =>
    encryptHistoryDeleteAnswerEntry({
      historyKey: bob.historyKey,
      clientMsgId,
      senderId: bobId,
      peerId: aliceId,
      target,
      accept,
      sentAt,
    });

  it("round-trips a delete request through the message and history envelopes", () => {
    expect(
      decryptTextMessage({
        recipientEncryptionPrivateKey: bob.encryption.privateKey,
        senderEncryptionPublicKey: alice.encryption.publicKey,
        senderId: aliceId,
        recipientId: bobId,
        ciphertext: encryptRequest(),
      }),
    ).toMatchObject({ v: 2, type: "delete_request", target, sentAt });
    expect(
      decryptHistoryEntry({
        historyKey: alice.historyKey,
        clientMsgId,
        senderId: aliceId,
        peerId: bobId,
        entry: historyRequest(),
      }),
    ).toMatchObject({ v: 2, type: "delete_request", target, sentAt });
  });

  it("round-trips both delete answers through the message and history envelopes", () => {
    for (const accept of [true, false]) {
      expect(
        decryptTextMessage({
          recipientEncryptionPrivateKey: alice.encryption.privateKey,
          senderEncryptionPublicKey: bob.encryption.publicKey,
          senderId: bobId,
          recipientId: aliceId,
          ciphertext: encryptAnswer(accept),
        }),
      ).toMatchObject({ v: 2, type: "delete_answer", target, accept, sentAt });
      expect(
        decryptHistoryEntry({
          historyKey: bob.historyKey,
          clientMsgId,
          senderId: bobId,
          peerId: aliceId,
          entry: historyAnswer(accept),
        }),
      ).toMatchObject({ v: 2, type: "delete_answer", target, accept, sentAt });
    }
  });

  it("binds delete requests and answers to the same participants and history entry", () => {
    const request = encryptRequest();
    for (const participant of [
      { senderId: bobId, recipientId: aliceId },
      { senderId: aliceId, recipientId: aliceId },
    ]) {
      expect(() =>
        decryptTextMessage({
          recipientEncryptionPrivateKey: bob.encryption.privateKey,
          senderEncryptionPublicKey: alice.encryption.publicKey,
          ciphertext: request,
          ...participant,
        }),
      ).toThrow(DecryptError);
    }
    const answer = encryptAnswer(true);
    for (const participant of [
      { senderId: aliceId, recipientId: bobId },
      { senderId: bobId, recipientId: bobId },
    ]) {
      expect(() =>
        decryptTextMessage({
          recipientEncryptionPrivateKey: alice.encryption.privateKey,
          senderEncryptionPublicKey: bob.encryption.publicKey,
          ciphertext: answer,
          ...participant,
        }),
      ).toThrow(DecryptError);
    }
    const entry = historyRequest();
    for (const attempt of [
      { historyKey: bob.historyKey, clientMsgId },
      { historyKey: alice.historyKey, clientMsgId: "0b".repeat(16) },
      {
        historyKey: alice.historyKey,
        clientMsgId,
        senderId: bobId,
        peerId: bobId,
      },
    ]) {
      expect(() =>
        decryptHistoryEntry({
          senderId: aliceId,
          peerId: bobId,
          entry,
          ...attempt,
        }),
      ).toThrow(DecryptError);
    }
  });

  it("skips malformed delete payloads like unknown message types", () => {
    expect(parseDeleteRequestPayload({ target })).toEqual({ target });
    expect(parseDeleteAnswerPayload({ target, accept: false })).toEqual({
      target,
      accept: false,
    });
    for (const invalid of [
      null,
      "delete_request",
      {},
      { target: "bad" },
      { target: "ab".repeat(16) },
      { target: 42 },
    ])
      expect(parseDeleteRequestPayload(invalid)).toBeNull();
    for (const invalid of [
      null,
      "delete_answer",
      {},
      { accept: true },
      { target: "bad", accept: true },
      { target },
      { target, accept: "true" },
      { target, accept: 1 },
      { target, accept: null },
    ])
      expect(parseDeleteAnswerPayload(invalid)).toBeNull();
  });

  it("rejects invalid delete input before sending", () => {
    const base = {
      senderEncryptionPrivateKey: alice.encryption.privateKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      senderId: aliceId,
      recipientId: bobId,
      target,
      sentAt,
    };
    expect(() =>
      encryptDeleteRequestMessage({ ...base, target: "bad" }),
    ).toThrow(TypeError);
    expect(() =>
      encryptDeleteRequestMessage({ ...base, target }),
    ).not.toThrow();
    expect(() =>
      encryptDeleteRequestMessage({ ...base, senderId: "bad" }),
    ).toThrow(TypeError);
    expect(() =>
      encryptDeleteRequestMessage({
        ...base,
        recipientEncryptionPublicKey: new Uint8Array(31),
      }),
    ).toThrow(TypeError);
    expect(() =>
      encryptDeleteRequestMessage({ ...base, sentAt: Number.NaN }),
    ).toThrow(TypeError);
    expect(() =>
      encryptDeleteAnswerMessage({
        ...base,
        accept: "true" as unknown as boolean,
      }),
    ).toThrow(TypeError);
    const historyBase = {
      historyKey: alice.historyKey,
      clientMsgId,
      senderId: aliceId,
      peerId: bobId,
      target,
      sentAt,
    };
    expect(() =>
      encryptHistoryDeleteRequestEntry({ ...historyBase, target: "bad" }),
    ).toThrow(TypeError);
    expect(() =>
      encryptHistoryDeleteRequestEntry({
        ...historyBase,
        clientMsgId: "0c".repeat(15),
      }),
    ).toThrow(TypeError);
    expect(() =>
      encryptHistoryDeleteRequestEntry({
        ...historyBase,
        peerId: "ff".repeat(31),
      }),
    ).toThrow(TypeError);
    expect(() =>
      encryptHistoryDeleteAnswerEntry({
        ...historyBase,
        accept: 1 as unknown as boolean,
      }),
    ).toThrow(TypeError);
    expect(() =>
      encryptHistoryDeleteAnswerEntry({
        ...historyBase,
        target: "bad",
        accept: true,
      }),
    ).toThrow(TypeError);
  });
});
