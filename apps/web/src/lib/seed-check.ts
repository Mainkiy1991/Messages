import {
  deriveKeys,
  normalizeMnemonic,
  userIdFromPublicKey,
  validateMnemonic,
} from "@messages/crypto";

/**
 * Checks whether the entered seed phrase belongs to the given account.
 * Works entirely in memory: nothing is logged, stored or sent anywhere.
 */
export function phraseMatchesAccount(
  input: string,
  accountId: string,
): boolean {
  try {
    const normalized = normalizeMnemonic(input);
    if (!validateMnemonic(normalized)) return false;
    const derived = deriveKeys(normalized);
    return userIdFromPublicKey(derived.identity.publicKey) === accountId;
  } catch {
    return false;
  }
}
