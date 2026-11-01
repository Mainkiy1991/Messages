import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import {
  generateMnemonic as bip39GenerateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic as validateBip39Mnemonic,
} from "@scure/bip39";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export type KeyPair = { publicKey: Uint8Array; privateKey: Uint8Array };

export type DerivedKeys = {
  identity: KeyPair;
  encryption: KeyPair;
  historyKey: Uint8Array;
};

const HKDF_SALT = new Uint8Array(32);
const encoder = new TextEncoder();
const PIN_OPSLIMIT = 3;
const PIN_MEMLIMIT = 64 * 1024 * 1024;
const PIN_KEY_LENGTH = 32;

async function derivePinKey(
  pin: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const pinBytes = encoder.encode(pin.normalize("NFKC"));
  try {
    const { default: sodium } = await import("libsodium-wrappers-sumo");
    await sodium.ready;
    return sodium.crypto_pwhash(
      PIN_KEY_LENGTH,
      pinBytes,
      salt,
      PIN_OPSLIMIT,
      PIN_MEMLIMIT,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
  } catch {
    throw new Error("PIN_KDF_FAILED");
  } finally {
    pinBytes.fill(0);
  }
}

export function normalizeMnemonic(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/gu, " ");
}

export function generateMnemonic(words: 12 | 24): string {
  if (words !== 12 && words !== 24) {
    throw new RangeError("Mnemonic length must be 12 or 24 words");
  }
  return bip39GenerateMnemonic(wordlist, words === 12 ? 128 : 256);
}

export function validateMnemonic(mnemonic: string): boolean {
  return validateBip39Mnemonic(normalizeMnemonic(mnemonic), wordlist);
}

export function deriveKeys(mnemonic: string): DerivedKeys {
  if (!validateMnemonic(mnemonic)) {
    throw new Error("Invalid BIP-39 mnemonic");
  }

  const normalized = normalizeMnemonic(mnemonic);
  const seed = mnemonicToSeedSync(normalized.normalize("NFKD"));
  const identityPrivateKey = derive(seed, "messages/v1/identity");
  const encryptionPrivateKey = derive(seed, "messages/v1/encryption");
  const historyKey = derive(seed, "messages/v1/history");

  return {
    identity: {
      privateKey: identityPrivateKey,
      publicKey: ed25519.getPublicKey(identityPrivateKey),
    },
    encryption: {
      privateKey: encryptionPrivateKey,
      publicKey: x25519.getPublicKey(encryptionPrivateKey),
    },
    historyKey,
  };
}

export function userIdFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32)
    throw new RangeError("Public key must be 32 bytes");
  return Array.from(publicKey, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function shortId(userId: string): string {
  return userId.slice(-10);
}

function derive(seed: Uint8Array, info: string): Uint8Array {
  return hkdf(sha256, seed, HKDF_SALT, encoder.encode(info), 32);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/iu.test(hex)) {
    throw new TypeError("Invalid hexadecimal string");
  }
  return Uint8Array.from(hex.match(/.{2}/gu) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
}

export type WrappedSecrets = {
  v: 1;
  kdf: "argon2id";
  mem: 65536;
  iters: 3;
  salt: string;
  nonce: string;
  ciphertext: string;
};

export type WrappedServerSession = {
  v: 1;
  nonce: string;
  ciphertext: string;
};

const SERVER_SESSION_INFO = "messages/v1/pin-server-session";

export function wrapServerSession(
  sessionBytes: Uint8Array,
  identityPrivateKey: Uint8Array,
): WrappedServerSession {
  if (!(sessionBytes instanceof Uint8Array) || sessionBytes.length === 0)
    throw new TypeError("Server session data is required");
  if (
    !(identityPrivateKey instanceof Uint8Array) ||
    identityPrivateKey.length !== 32
  )
    throw new TypeError("Identity private key must be 32 bytes");
  const key = derive(identityPrivateKey, SERVER_SESSION_INFO);
  const nonce = randomBytes(24);
  try {
    const ciphertext = xchacha20poly1305(
      key,
      nonce,
      encoder.encode(`${SERVER_SESSION_INFO}/aad`),
    ).encrypt(sessionBytes);
    return {
      v: 1,
      nonce: bytesToBase64(nonce),
      ciphertext: bytesToBase64(ciphertext),
    };
  } finally {
    key.fill(0);
  }
}

export function unwrapServerSession(
  blob: unknown,
  identityPrivateKey: Uint8Array,
): Uint8Array {
  try {
    if (
      !(identityPrivateKey instanceof Uint8Array) ||
      identityPrivateKey.length !== 32
    )
      throw new Error();
    const value = blob as Partial<WrappedServerSession>;
    if (
      !value ||
      typeof value !== "object" ||
      value.v !== 1 ||
      typeof value.nonce !== "string" ||
      typeof value.ciphertext !== "string"
    )
      throw new Error();
    const nonce = base64ToBytes(value.nonce);
    const ciphertext = base64ToBytes(value.ciphertext);
    if (nonce.length !== 24 || ciphertext.length < 16) throw new Error();
    const key = derive(identityPrivateKey, SERVER_SESSION_INFO);
    try {
      return xchacha20poly1305(
        key,
        nonce,
        encoder.encode(`${SERVER_SESSION_INFO}/aad`),
      ).decrypt(ciphertext);
    } finally {
      key.fill(0);
    }
  } catch {
    throw new Error("SERVER_SESSION_INVALID");
  }
}

/** Encrypt opaque session-secret bytes using the production Argon2id parameters. */
export async function wrapSecrets(
  secretsBytes: Uint8Array,
  pin: string,
): Promise<WrappedSecrets> {
  if (!(secretsBytes instanceof Uint8Array) || secretsBytes.length === 0)
    throw new TypeError("Secret data is required");
  if (typeof pin !== "string" || Array.from(pin).length < 6)
    throw new TypeError("PIN_TOO_SHORT");
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const key = await derivePinKey(pin, salt);
  try {
    const aad = encoder.encode("messages/v1/pin-secrets");
    const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(secretsBytes);
    return {
      v: 1,
      kdf: "argon2id",
      mem: 65536,
      iters: 3,
      salt: bytesToBase64(salt),
      nonce: bytesToBase64(nonce),
      ciphertext: bytesToBase64(ciphertext),
    };
  } finally {
    key.fill(0);
  }
}

/** Decrypt an authenticated PIN blob; all malformed blobs and wrong PINs share a safe error. */
export async function unwrapSecrets(
  blob: unknown,
  pin: string,
): Promise<Uint8Array> {
  try {
    if (typeof pin !== "string" || Array.from(pin).length < 6)
      throw new Error();
    const value = blob as Partial<WrappedSecrets>;
    if (
      !value ||
      typeof value !== "object" ||
      value.v !== 1 ||
      value.kdf !== "argon2id" ||
      value.mem !== 65536 ||
      value.iters !== 3
    )
      throw new Error();
    const salt = base64ToBytes(value.salt!);
    const nonce = base64ToBytes(value.nonce!);
    const ciphertext = base64ToBytes(value.ciphertext!);
    if (salt.length !== 16 || nonce.length !== 24 || ciphertext.length < 16)
      throw new Error();
    const key = await derivePinKey(pin, salt);
    try {
      return xchacha20poly1305(
        key,
        nonce,
        encoder.encode("messages/v1/pin-secrets"),
      ).decrypt(ciphertext);
    } finally {
      key.fill(0);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "PIN_KDF_FAILED")
      throw error;
    throw new Error("PIN_INVALID");
  }
}

const MESSAGE_INFO = encoder.encode("messages/v1/message");
const HISTORY_INFO = encoder.encode("messages/v1/history-entry");
const CONTACTS_INFO = encoder.encode("messages/v1/contacts");
const VERSION = 1;
const MESSAGE_VERSION_V2 = 2;
const NONCE_LENGTH = 24;
const MAX_TEXT_CHARS = 4000;
const MAX_TEXT_BYTES = 16 * 1024;

export class DecryptError extends Error {
  constructor() {
    super("DECRYPT_FAILED");
    this.name = "DecryptError";
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return globalThis.btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  )
    throw new TypeError("Invalid base64 string");
  try {
    const binary = globalThis.atob(value);
    const result = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    if (bytesToBase64(result) !== value)
      throw new TypeError("Invalid base64 string");
    return result;
  } catch {
    throw new TypeError("Invalid base64 string");
  }
}

export function newClientMsgId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function newReplayMessageId(): string {
  return bytesToBase64(randomBytes(16));
}

export function encryptTextMessage(input: {
  senderEncryptionPrivateKey: Uint8Array;
  recipientEncryptionPublicKey: Uint8Array;
  senderId: string;
  recipientId: string;
  text: string;
  sentAt?: number;
  messageId?: string;
}): string {
  checkKey(input.senderEncryptionPrivateKey);
  checkKey(input.recipientEncryptionPublicKey);
  checkIds(input.senderId, input.recipientId);
  checkText(input.text);
  const sentAt = input.sentAt ?? Date.now();
  checkSentAt(sentAt);
  const id = input.messageId ?? newReplayMessageId();
  const idBytes = base64ToBytes(id);
  if (idBytes.length !== 16) throw new TypeError("Invalid message id");
  const senderEncryptionPublicKey = x25519.getPublicKey(
    input.senderEncryptionPrivateKey,
  );
  const shared = x25519.getSharedSecret(
    input.senderEncryptionPrivateKey,
    input.recipientEncryptionPublicKey,
  );
  if (shared.every((byte) => byte === 0))
    throw new TypeError("Invalid X25519 shared secret");
  const key = hkdf(
    sha256,
    shared,
    HKDF_SALT,
    concat(
      MESSAGE_INFO,
      senderEncryptionPublicKey,
      input.recipientEncryptionPublicKey,
    ),
    32,
  );
  const nonce = randomBytes(NONCE_LENGTH);
  const aad = encoder.encode(
    `messages/v2/message\n${input.senderId}\n${input.recipientId}\n${bytesToHex(senderEncryptionPublicKey)}\n${bytesToHex(input.recipientEncryptionPublicKey)}\n${id}`,
  );
  const plaintext = encoder.encode(
    JSON.stringify({
      v: 2,
      id,
      type: "text",
      text: input.text,
      sentAt,
    }),
  );
  return bytesToBase64(
    concat(
      Uint8Array.of(MESSAGE_VERSION_V2),
      idBytes,
      nonce,
      xchacha20poly1305(key, nonce, aad).encrypt(plaintext),
    ),
  );
}

export function decryptTextMessage(input: {
  recipientEncryptionPrivateKey: Uint8Array;
  senderEncryptionPublicKey: Uint8Array;
  senderId: string;
  recipientId: string;
  ciphertext: string;
}): { text?: string; sentAt?: number; v?: 2; id?: string; type?: string } {
  try {
    checkKey(input.recipientEncryptionPrivateKey);
    checkKey(input.senderEncryptionPublicKey);
    checkIds(input.senderId, input.recipientId);
    const packed = base64ToBytes(input.ciphertext);
    const isV2 = packed[0] === MESSAGE_VERSION_V2;
    const idBytes = isV2 ? packed.subarray(1, 17) : undefined;
    if (
      isV2 &&
      (idBytes!.length !== 16 || packed.length < 1 + 16 + NONCE_LENGTH + 16)
    )
      throw new Error();
    const decoded = isV2
      ? {
          nonce: packed.subarray(17, 17 + NONCE_LENGTH),
          body: packed.subarray(17 + NONCE_LENGTH),
        }
      : decodeEnvelope(packed);
    const recipientEncryptionPublicKey = x25519.getPublicKey(
      input.recipientEncryptionPrivateKey,
    );
    const shared = x25519.getSharedSecret(
      input.recipientEncryptionPrivateKey,
      input.senderEncryptionPublicKey,
    );
    if (shared.every((byte) => byte === 0))
      throw new Error("small order point");
    const key = hkdf(
      sha256,
      shared,
      HKDF_SALT,
      concat(
        MESSAGE_INFO,
        input.senderEncryptionPublicKey,
        recipientEncryptionPublicKey,
      ),
      32,
    );
    if (isV2) {
      const id = bytesToBase64(idBytes!);
      const aad = encoder.encode(
        `messages/v2/message\n${input.senderId}\n${input.recipientId}\n${bytesToHex(input.senderEncryptionPublicKey)}\n${bytesToHex(recipientEncryptionPublicKey)}\n${id}`,
      );
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          xchacha20poly1305(key, decoded.nonce, aad).decrypt(decoded.body),
        ),
      ) as Record<string, unknown>;
      if (value.v !== 2 || value.id !== id || typeof value.type !== "string")
        throw new Error();
      if (typeof value.sentAt !== "number") throw new Error();
      checkSentAt(value.sentAt);
      if (value.type !== "text")
        return { v: 2, id, type: value.type, sentAt: value.sentAt };
      if (typeof value.text !== "string") throw new Error();
      checkText(value.text);
      return {
        v: 2,
        id,
        type: "text",
        text: value.text,
        sentAt: value.sentAt,
      } as {
        v: 2;
        id: string;
        type: string;
        text: string;
        sentAt: number;
      };
    }
    const aad = encoder.encode(
      `messages/v1/message\n${input.senderId}\n${input.recipientId}`,
    );
    return decodePayload(
      xchacha20poly1305(key, decoded.nonce, aad).decrypt(decoded.body),
    );
  } catch {
    throw new DecryptError();
  }
}

export function encryptHistoryEntry(input: {
  historyKey: Uint8Array;
  clientMsgId: string;
  peerId: string;
  text: string;
  sentAt: number;
  senderId: string;
  messageId?: string;
}): string {
  checkKey(input.historyKey);
  checkId(input.clientMsgId, 32, /^[0-9a-f]{32}$/u);
  checkId(input.peerId, 64, /^[0-9a-f]{64}$/u);
  checkIds(input.senderId, input.peerId);
  checkText(input.text);
  checkSentAt(input.sentAt);
  const key = hkdf(sha256, input.historyKey, HKDF_SALT, HISTORY_INFO, 32);
  const nonce = randomBytes(NONCE_LENGTH);
  const id = input.messageId ?? newReplayMessageId();
  const idBytes = base64ToBytes(id);
  if (idBytes.length !== 16) throw new TypeError("Invalid message id");
  const aad = encoder.encode(
    `messages/v2/history-entry\n${input.senderId}\n${input.peerId}\n${id}\n${input.clientMsgId}`,
  );
  const plaintext = encoder.encode(
    JSON.stringify({
      v: 2,
      id,
      type: "text",
      text: input.text,
      sentAt: input.sentAt,
    }),
  );
  return bytesToBase64(
    concat(
      Uint8Array.of(MESSAGE_VERSION_V2),
      idBytes,
      nonce,
      xchacha20poly1305(key, nonce, aad).encrypt(plaintext),
    ),
  );
}

export function decryptHistoryEntry(input: {
  historyKey: Uint8Array;
  clientMsgId: string;
  peerId: string;
  entry: string;
  senderId: string;
}): { text?: string; sentAt?: number; v?: 2; id?: string; type?: string } {
  try {
    checkKey(input.historyKey);
    checkId(input.clientMsgId, 32, /^[0-9a-f]{32}$/u);
    checkId(input.peerId, 64, /^[0-9a-f]{64}$/u);
    checkIds(input.senderId, input.peerId);
    const packed = base64ToBytes(input.entry);
    const isV2 = packed[0] === MESSAGE_VERSION_V2;
    const idBytes = isV2 ? packed.subarray(1, 17) : undefined;
    if (
      isV2 &&
      (idBytes!.length !== 16 || packed.length < 1 + 16 + NONCE_LENGTH + 16)
    )
      throw new Error();
    const decoded = isV2
      ? {
          nonce: packed.subarray(17, 17 + NONCE_LENGTH),
          body: packed.subarray(17 + NONCE_LENGTH),
        }
      : decodeEnvelope(packed);
    const key = hkdf(sha256, input.historyKey, HKDF_SALT, HISTORY_INFO, 32);
    if (isV2) {
      const id = bytesToBase64(idBytes!);
      const aad = encoder.encode(
        `messages/v2/history-entry\n${input.senderId}\n${input.peerId}\n${id}\n${input.clientMsgId}`,
      );
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          xchacha20poly1305(key, decoded.nonce, aad).decrypt(decoded.body),
        ),
      ) as Record<string, unknown>;
      if (value.v !== 2 || value.id !== id || typeof value.type !== "string")
        throw new Error();
      if (typeof value.sentAt !== "number") throw new Error();
      checkSentAt(value.sentAt);
      if (value.type !== "text")
        return { v: 2, id, type: value.type, sentAt: value.sentAt };
      if (typeof value.text !== "string") throw new Error();
      checkText(value.text);
      return {
        v: 2,
        id,
        type: "text",
        text: value.text,
        sentAt: value.sentAt,
      } as {
        v: 2;
        id: string;
        type: string;
        text: string;
        sentAt: number;
      };
    }
    const aad = encoder.encode(
      `messages/v1/history-entry\n${input.clientMsgId}\n${input.peerId}`,
    );
    return decodePayload(
      xchacha20poly1305(key, decoded.nonce, aad).decrypt(decoded.body),
    );
  } catch {
    throw new DecryptError();
  }
}

export function encryptContactBook(input: {
  historyKey: Uint8Array;
  contacts: Record<string, string>;
}): string {
  checkKey(input.historyKey);
  validateContacts(input.contacts);
  const key = hkdf(sha256, input.historyKey, HKDF_SALT, CONTACTS_INFO, 32);
  const nonce = randomBytes(NONCE_LENGTH);
  const plaintext = encoder.encode(
    JSON.stringify({ v: VERSION, contacts: input.contacts }),
  );
  return bytesToBase64(
    concat(
      Uint8Array.of(VERSION),
      nonce,
      xchacha20poly1305(key, nonce, CONTACTS_INFO).encrypt(plaintext),
    ),
  );
}

export function decryptContactBook(input: {
  historyKey: Uint8Array;
  blob: string;
}): Record<string, string> {
  try {
    checkKey(input.historyKey);
    const packed = base64ToBytes(input.blob);
    const decoded = decodeEnvelope(packed);
    const key = hkdf(sha256, input.historyKey, HKDF_SALT, CONTACTS_INFO, 32);
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        xchacha20poly1305(key, decoded.nonce, CONTACTS_INFO).decrypt(
          decoded.body,
        ),
      ),
    ) as Record<string, unknown>;
    if (
      value.v !== VERSION ||
      !value.contacts ||
      typeof value.contacts !== "object" ||
      Array.isArray(value.contacts)
    )
      throw new Error("Invalid contact book");
    const contacts = value.contacts as Record<string, string>;
    validateContacts(contacts);
    return contacts;
  } catch {
    throw new DecryptError();
  }
}

function validateContacts(contacts: Record<string, string>): void {
  if (
    !contacts ||
    typeof contacts !== "object" ||
    Array.isArray(contacts) ||
    Object.keys(contacts).length > 1000
  )
    throw new TypeError("Invalid contacts");
  for (const [userId, name] of Object.entries(contacts)) {
    if (
      !/^[0-9a-f]{64}$/u.test(userId) ||
      typeof name !== "string" ||
      name.trim().length === 0 ||
      Array.from(name.trim()).length > 64
    )
      throw new TypeError("Invalid contact");
  }
}

function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function checkKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== 32)
    throw new TypeError("Key must be 32 bytes");
}

function checkId(value: string, length: number, pattern: RegExp): void {
  if (
    typeof value !== "string" ||
    value.length !== length ||
    !pattern.test(value)
  )
    throw new TypeError("Invalid identifier");
}

function checkIds(senderId: string, recipientId: string): void {
  checkId(senderId, 64, /^[0-9a-f]{64}$/u);
  checkId(recipientId, 64, /^[0-9a-f]{64}$/u);
}

function checkText(text: string): void {
  if (
    typeof text !== "string" ||
    text.trim().length === 0 ||
    Array.from(text).length > MAX_TEXT_CHARS ||
    encoder.encode(text).length > MAX_TEXT_BYTES
  )
    throw new TypeError("Invalid message text");
}

function checkSentAt(sentAt: number): void {
  if (
    typeof sentAt !== "number" ||
    !Number.isFinite(sentAt) ||
    !Number.isFinite(new Date(sentAt).getTime())
  )
    throw new TypeError("Invalid timestamp");
}

function decodeEnvelope(packed: Uint8Array): {
  nonce: Uint8Array;
  body: Uint8Array;
} {
  if (packed.length < 1 + NONCE_LENGTH + 16 || packed[0] !== VERSION)
    throw new Error("Invalid envelope");
  return {
    nonce: packed.subarray(1, 1 + NONCE_LENGTH),
    body: packed.subarray(1 + NONCE_LENGTH),
  };
}

function decodePayload(bytes: Uint8Array): { text: string; sentAt: number } {
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as Record<string, unknown>;
  if (
    value.v !== VERSION ||
    typeof value.text !== "string" ||
    typeof value.sentAt !== "number" ||
    !Number.isFinite(value.sentAt)
  )
    throw new Error("Invalid payload");
  checkText(value.text);
  return { text: value.text, sentAt: value.sentAt };
}

export function signAuth(
  identityPrivateKey: Uint8Array,
  challengeId: string,
  challengeHex: string,
): Uint8Array {
  const message = encoder.encode(
    `messages/v1/auth\n${challengeId}\n${challengeHex}`,
  );
  return ed25519.sign(message, identityPrivateKey);
}

export function verifyAuth(
  identityPublicKey: Uint8Array,
  challengeId: string,
  challengeHex: string,
  signature: Uint8Array,
): boolean {
  try {
    return ed25519.verify(
      signature,
      encoder.encode(`messages/v1/auth\n${challengeId}\n${challengeHex}`),
      identityPublicKey,
    );
  } catch {
    return false;
  }
}

export function signKeyBinding(
  identityPrivateKey: Uint8Array,
  encryptionPublicKey: Uint8Array,
): Uint8Array {
  const prefix = encoder.encode("messages/v1/key-binding\n");
  const message = new Uint8Array(prefix.length + encryptionPublicKey.length);
  message.set(prefix);
  message.set(encryptionPublicKey, prefix.length);
  return ed25519.sign(message, identityPrivateKey);
}

export function verifyKeyBinding(
  identityPublicKey: Uint8Array,
  encryptionPublicKey: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    const prefix = encoder.encode("messages/v1/key-binding\n");
    const message = new Uint8Array(prefix.length + encryptionPublicKey.length);
    message.set(prefix);
    message.set(encryptionPublicKey, prefix.length);
    return ed25519.verify(signature, message, identityPublicKey);
  } catch {
    return false;
  }
}
