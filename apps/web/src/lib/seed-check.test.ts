import { describe, expect, it } from "vitest";
import { deriveKeys, userIdFromPublicKey } from "@messages/crypto";
import { phraseMatchesAccount } from "./seed-check.js";

const phrase12 =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const phrase24 =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const otherPhrase12 =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";

function accountIdOf(phrase: string): string {
  return userIdFromPublicKey(deriveKeys(phrase).identity.publicKey);
}

describe("seed phrase check before sign-out", () => {
  it("accepts the 12-word phrase of the account", () => {
    expect(phraseMatchesAccount(phrase12, accountIdOf(phrase12))).toBe(true);
  });

  it("accepts the 24-word phrase of the account", () => {
    expect(phraseMatchesAccount(phrase24, accountIdOf(phrase24))).toBe(true);
  });

  it("accepts extra spaces, line breaks and letter case like the sign-in screen", () => {
    const messy = `  ABANDON\tabandon   abandon\nabandon\n\nabandon abandon abandon abandon abandon abandon abandon\nABOUT  `;
    expect(phraseMatchesAccount(messy, accountIdOf(phrase12))).toBe(true);
  });

  it("rejects another valid phrase", () => {
    expect(phraseMatchesAccount(otherPhrase12, accountIdOf(phrase12))).toBe(
      false,
    );
  });

  it("rejects an invalid phrase", () => {
    expect(
      phraseMatchesAccount("abandon abandon about", accountIdOf(phrase12)),
    ).toBe(false);
  });

  it("rejects an empty phrase", () => {
    expect(phraseMatchesAccount("", accountIdOf(phrase12))).toBe(false);
  });
});
