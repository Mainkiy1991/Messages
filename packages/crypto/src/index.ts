import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import {
  generateMnemonic as bip39GenerateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic as validateBip39Mnemonic,
} from "@scure/bip39";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
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
