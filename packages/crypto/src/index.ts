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

const MESSAGE_INFO = encoder.encode("messages/v1/message");
const HISTORY_INFO = encoder.encode("messages/v1/history-entry");
const VERSION = 1;
const NONCE_LENGTH = 24;
const MAX_TEXT_CHARS = 4000;
const MAX_TEXT_BYTES = 16 * 1024;

export class DecryptError extends Error {
  constructor() {
    super("Cannot decrypt message");
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

export function encryptTextMessage(input: {
  senderEncryptionPrivateKey: Uint8Array;
  recipientEncryptionPublicKey: Uint8Array;
  senderId: string;
  recipientId: string;
  text: string;
  sentAt?: number;
}): string {
  checkKey(input.senderEncryptionPrivateKey);
  checkKey(input.recipientEncryptionPublicKey);
  checkIds(input.senderId, input.recipientId);
  checkText(input.text);
  const sentAt = input.sentAt ?? Date.now();
  checkSentAt(sentAt);
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
    `messages/v1/message\n${input.senderId}\n${input.recipientId}`,
  );
  const plaintext = encoder.encode(
    JSON.stringify({ v: VERSION, text: input.text, sentAt }),
  );
  return bytesToBase64(
    concat(
      Uint8Array.of(VERSION),
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
}): { text: string; sentAt: number } {
  try {
    checkKey(input.recipientEncryptionPrivateKey);
    checkKey(input.senderEncryptionPublicKey);
    checkIds(input.senderId, input.recipientId);
    const packed = base64ToBytes(input.ciphertext);
    const decoded = decodeEnvelope(packed);
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
}): string {
  checkKey(input.historyKey);
  checkId(input.clientMsgId, 32, /^[0-9a-f]{32}$/iu);
  checkId(input.peerId, 64, /^[0-9a-f]{64}$/iu);
  checkText(input.text);
  checkSentAt(input.sentAt);
  const key = hkdf(sha256, input.historyKey, HKDF_SALT, HISTORY_INFO, 32);
  const nonce = randomBytes(NONCE_LENGTH);
  const aad = encoder.encode(
    `messages/v1/history-entry\n${input.clientMsgId}\n${input.peerId}`,
  );
  const plaintext = encoder.encode(
    JSON.stringify({ v: VERSION, text: input.text, sentAt: input.sentAt }),
  );
  return bytesToBase64(
    concat(
      Uint8Array.of(VERSION),
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
}): { text: string; sentAt: number } {
  try {
    checkKey(input.historyKey);
    checkId(input.clientMsgId, 32, /^[0-9a-f]{32}$/iu);
    checkId(input.peerId, 64, /^[0-9a-f]{64}$/iu);
    const packed = base64ToBytes(input.entry);
    const decoded = decodeEnvelope(packed);
    const key = hkdf(sha256, input.historyKey, HKDF_SALT, HISTORY_INFO, 32);
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
  checkId(senderId, 64, /^[0-9a-f]{64}$/iu);
  checkId(recipientId, 64, /^[0-9a-f]{64}$/iu);
}

function checkText(text: string): void {
  if (
    typeof text !== "string" ||
    text.trim().length === 0 ||
    text.length > MAX_TEXT_CHARS ||
    encoder.encode(text).length > MAX_TEXT_BYTES
  )
    throw new TypeError("Invalid message text");
}

function checkSentAt(sentAt: number): void {
  if (typeof sentAt !== "number" || !Number.isFinite(sentAt))
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
