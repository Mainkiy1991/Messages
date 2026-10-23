import { describe, expect, it } from "vitest";
import { deriveKeys, generateMnemonic, validateMnemonic } from "./index.js";

describe("mnemonic", () => {
  it("generates and validates 12 and 24 word phrases", () => {
    const twelve = generateMnemonic(12);
    const twentyFour = generateMnemonic(24);
    expect(twelve.split(" ")).toHaveLength(12);
    expect(twentyFour.split(" ")).toHaveLength(24);
    expect(validateMnemonic(twelve)).toBe(true);
    expect(validateMnemonic(twentyFour)).toBe(true);
  });

  it("rejects invalid phrases", () => {
    expect(validateMnemonic("not a valid recovery phrase")).toBe(false);
  });
});

describe("deriveKeys", () => {
  const phrase =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

  it("is deterministic", () => {
    expect(deriveKeys(phrase)).toEqual(deriveKeys(phrase));
  });

  it("derives different keys for different phrases", () => {
    const first = deriveKeys(phrase);
    const second = deriveKeys(
      "legal winner thank year wave sausage worth useful legal winner thank yellow",
    );
    expect(first.identity.publicKey).not.toEqual(second.identity.publicKey);
    expect(first.encryption.publicKey).not.toEqual(second.encryption.publicKey);
    expect(first.historyKey).not.toEqual(second.historyKey);
  });
});
