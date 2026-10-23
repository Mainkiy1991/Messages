import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  mnemonicToSeedSync,
  validateMnemonic as validateBip39Mnemonic,
} from "@scure/bip39";
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

import { generateMnemonic as bip39GenerateMnemonic } from "@scure/bip39";
