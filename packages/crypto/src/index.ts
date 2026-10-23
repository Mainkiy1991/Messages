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
const INFO_PREFIX = "messages:v1:";
const encoder = new TextEncoder();

export function generateMnemonic(words: 12 | 24): string {
  if (words !== 12 && words !== 24) {
    throw new RangeError("Mnemonic length must be 12 or 24 words");
  }
  return bip39GenerateMnemonic(wordlist, words === 12 ? 128 : 256);
}

export function validateMnemonic(mnemonic: string): boolean {
  return validateBip39Mnemonic(mnemonic, wordlist);
}

export function deriveKeys(mnemonic: string): DerivedKeys {
  if (!validateMnemonic(mnemonic)) {
    throw new Error("Invalid BIP-39 mnemonic");
  }

  const seed = mnemonicToSeedSync(mnemonic.normalize("NFKD"));
  const identityPrivateKey = derive(seed, "identity-ed25519");
  const encryptionPrivateKey = derive(seed, "encryption-x25519");
  const historyKey = derive(seed, "history-aes-256");

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

function derive(seed: Uint8Array, label: string): Uint8Array {
  return hkdf(
    sha256,
    seed,
    HKDF_SALT,
    encoder.encode(`${INFO_PREFIX}${label}`),
    32,
  );
}

import { generateMnemonic as bip39GenerateMnemonic } from "@scure/bip39";
