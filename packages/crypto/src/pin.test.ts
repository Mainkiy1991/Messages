import { describe, expect, it } from "vitest";
import { unwrapSecrets, wrapSecrets } from "./index.js";

describe("PIN secret wrapping", () => {
  const secret = new TextEncoder().encode("session secret bytes");
  it("wraps and unwraps with the correct PIN", async () => {
    const blob = await wrapSecrets(secret, "correct123");
    expect(blob).toMatchObject({ v: 1, kdf: "argon2id", mem: 65536, iters: 3 });
    expect(await unwrapSecrets(blob, "correct123")).toEqual(secret);
  }, 30000);
  it("rejects a wrong PIN and modified blob with a clear error", async () => {
    const blob = await wrapSecrets(secret, "correct123");
    await expect(unwrapSecrets(blob, "wrong123")).rejects.toThrow(
      "PIN_INVALID",
    );
    await expect(
      unwrapSecrets(
        { ...blob, ciphertext: blob.ciphertext.slice(0, -4) + "AAAA" },
        "correct123",
      ),
    ).rejects.toThrow("PIN_INVALID");
  }, 30000);
  it("uses fresh salts and nonces", async () => {
    const a = await wrapSecrets(secret, "correct123");
    const b = await wrapSecrets(secret, "correct123");
    expect(a.salt).not.toBe(b.salt);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  }, 30000);
  it("accepts Unicode PINs and normalizes them with NFKC", async () => {
    const blob = await wrapSecrets(secret, "ＡＢＣ１２３");
    expect(await unwrapSecrets(blob, "ABC123")).toEqual(secret);
    const cyrillicBlob = await wrapSecrets(secret, "пароль");
    expect(await unwrapSecrets(cyrillicBlob, "пароль")).toEqual(secret);
  }, 60000);
  it("counts Unicode code points for the minimum PIN length", async () => {
    await expect(wrapSecrets(secret, "парол")).rejects.toThrow("PIN_TOO_SHORT");
    await expect(wrapSecrets(secret, "🔒🔒🔒🔒🔒🔒")).resolves.toMatchObject({
      v: 1,
    });
  }, 30000);
  it("decrypts a blob produced by the previous Noble implementation", async () => {
    const legacyBlob = {
      v: 1 as const,
      kdf: "argon2id" as const,
      mem: 65536 as const,
      iters: 3 as const,
      salt: "AAECAwQFBgcICQoLDA0ODw==",
      nonce: "EBESExQVFhcYGRobHB0eHyAhIiMkJSYn",
      ciphertext: "qyr6THMux/IHpAYzhsUaNWmW545Ejs3QinfaestSpFXtN9p3",
    };
    const plaintext = await unwrapSecrets(legacyBlob, "legacyPin123");
    expect(new TextDecoder().decode(plaintext)).toBe("legacy Noble payload");
  }, 30000);
});
