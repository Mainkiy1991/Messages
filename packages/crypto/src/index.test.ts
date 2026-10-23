import { describe, expect, it } from "vitest";
import {
  deriveKeys,
  signAuth,
  signKeyBinding,
  verifyAuth,
  verifyKeyBinding,
  bytesToHex,
  hexToBytes,
  generateMnemonic,
  normalizeMnemonic,
  shortId,
  userIdFromPublicKey,
  validateMnemonic,
} from "./index.js";

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

  it("normalizes whitespace, line breaks, and case", () => {
    expect(normalizeMnemonic("  ABANDON\n  abandon\tABOUT  ")).toBe(
      "abandon abandon about",
    );
    expect(
      validateMnemonic(" ABANDON\n" + "abandon ".repeat(10) + "about "),
    ).toBe(true);
  });
});

describe("deriveKeys", () => {
  const phrase =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

  it("is deterministic", () => {
    expect(deriveKeys(phrase)).toEqual(deriveKeys(phrase));
  });

  it("derives 32-byte keys from a 24-word phrase, all distinct", () => {
    const keys = deriveKeys(generateMnemonic(24));
    expect(keys.identity.privateKey).toHaveLength(32);
    expect(keys.identity.publicKey).toHaveLength(32);
    expect(keys.encryption.privateKey).toHaveLength(32);
    expect(keys.encryption.publicKey).toHaveLength(32);
    expect(keys.historyKey).toHaveLength(32);
    expect(
      new Set(
        [
          keys.identity.privateKey,
          keys.encryption.privateKey,
          keys.historyKey,
        ].map(hex),
      ).size,
    ).toBe(3);
  });

  it("rejects an invalid phrase without including it in the error", () => {
    expect(() => deriveKeys("secret phrase that should not leak")).toThrow(
      "Invalid BIP-39 mnemonic",
    );
    try {
      deriveKeys("secret phrase that should not leak");
    } catch (error) {
      expect(String(error)).not.toContain("secret phrase");
    }
  });

  it("keeps the account derivation reference values stable", () => {
    const keys = deriveKeys(phrase);
    // НЕ МЕНЯТЬ: изменение сломает все существующие аккаунты
    expect(hex(keys.identity.publicKey)).toBe(
      "8a9c1aefc909378c8c9181f3f12aa42365b82296af6295b6948d8f23a5a100ad",
    );
    expect(hex(keys.encryption.publicKey)).toBe(
      "d1bb531b4b3809fee056aa2c43935bd0ebf701571564d3442484c230ba312855",
    );
    expect(hex(keys.historyKey)).toBe(
      "33f76d115b18f50a90e9eb9b36d53872db5efab9eef58c16f983099c857373eb",
    );
  });

  it("formats the user ID as lowercase hex and shortens it from the end", () => {
    const id = userIdFromPublicKey(new Uint8Array(32).fill(0xab));
    expect(id).toBe("ab".repeat(32));
    expect(shortId(id)).toBe("ab".repeat(5));
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

describe("authentication signatures", () => {
  const keys = deriveKeys(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  );
  const challenge = "ab".repeat(32);
  const auth = signAuth(keys.identity.privateKey, "01".repeat(16), challenge);
  const binding = signKeyBinding(
    keys.identity.privateKey,
    keys.encryption.publicKey,
  );
  it("round-trips strict hex", () => {
    expect(bytesToHex(hexToBytes("00aB"))).toBe("00ab");
    expect(() => hexToBytes("0")).toThrow();
    expect(() => hexToBytes("gg")).toThrow();
  });
  it("verifies domain-separated auth and key binding", () => {
    expect(auth).toHaveLength(64);
    expect(bytesToHex(auth)).toBe(
      "b88f8a2c1a6193948151dbef073962b79d2012fec1b9ac6f6a562c1a75a20c1a49b619c18110e5a49f368309fda18b480a8ce80ada4412536c7ec67bfde2c002",
    );
    expect(
      verifyAuth(keys.identity.publicKey, "01".repeat(16), challenge, auth),
    ).toBe(true);
    expect(
      verifyAuth(keys.identity.publicKey, "02".repeat(16), challenge, auth),
    ).toBe(false);
    expect(
      verifyAuth(
        keys.identity.publicKey,
        "01".repeat(16),
        "cd".repeat(32),
        auth,
      ),
    ).toBe(false);
    expect(
      verifyAuth(
        deriveKeys(
          "legal winner thank year wave sausage worth useful legal winner thank yellow",
        ).identity.publicKey,
        "01".repeat(16),
        challenge,
        auth,
      ),
    ).toBe(false);
    expect(
      verifyAuth(
        keys.identity.publicKey,
        "01".repeat(16),
        challenge,
        auth.slice(0, 10),
      ),
    ).toBe(false);
    expect(
      verifyKeyBinding(
        keys.identity.publicKey,
        keys.encryption.publicKey,
        binding,
      ),
    ).toBe(true);
    expect(
      verifyKeyBinding(keys.identity.publicKey, new Uint8Array(32), binding),
    ).toBe(false);
    expect(
      verifyAuth(keys.identity.publicKey, "01".repeat(16), challenge, binding),
    ).toBe(false);
    expect(
      verifyKeyBinding(
        keys.identity.publicKey,
        keys.encryption.publicKey,
        auth,
      ),
    ).toBe(false);
    expect(verifyAuth(new Uint8Array(), "x", "y", new Uint8Array())).toBe(
      false,
    );
    expect(
      verifyKeyBinding(new Uint8Array(), new Uint8Array(), new Uint8Array()),
    ).toBe(false);
  });
});

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
