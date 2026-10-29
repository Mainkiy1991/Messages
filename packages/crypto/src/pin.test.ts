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
      /PIN|повреж/u,
    );
    await expect(
      unwrapSecrets(
        { ...blob, ciphertext: blob.ciphertext.slice(0, -4) + "AAAA" },
        "correct123",
      ),
    ).rejects.toThrow(/PIN|повреж/u);
  }, 30000);
  it("uses fresh salts and nonces", async () => {
    const a = await wrapSecrets(secret, "correct123");
    const b = await wrapSecrets(secret, "correct123");
    expect(a.salt).not.toBe(b.salt);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  }, 30000);
});
