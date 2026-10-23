import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deriveKeys,
  bytesToHex,
  signAuth,
  signKeyBinding,
} from "@messages/crypto";
import { buildApp } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  console.warn(
    "Skipping server integration tests: TEST_DATABASE_URL is not set (CI sets this to PostgreSQL 16).",
  );
const { Pool } = pg;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const suite = databaseUrl ? describe : describe.skip;

suite("server authentication (PostgreSQL)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let clock = Date.now();
  const keys = deriveKeys(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  );
  const identityPublicKey = bytesToHex(keys.identity.publicKey);
  const encryptionPublicKey = bytesToHex(keys.encryption.publicKey);
  beforeAll(async () => {
    await pool!.query(
      "DROP TABLE IF EXISTS sessions, users, schema_migrations CASCADE",
    );
    await pool!.query(
      await readFile(
        join(import.meta.dirname, "..", "migrations", "001_initial.sql"),
        "utf8",
      ),
    );
    app = await buildApp({ databaseUrl, now: () => clock });
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  async function login(overrides: Record<string, unknown> = {}) {
    const challenge = (
      await app.inject({ method: "POST", url: "/auth/challenge", payload: {} })
    ).json();
    const payload = {
      challengeId: challenge.challengeId,
      identityPublicKey,
      encryptionPublicKey,
      keyBindingSignature: bytesToHex(
        signKeyBinding(keys.identity.privateKey, keys.encryption.publicKey),
      ),
      signature: bytesToHex(
        signAuth(
          keys.identity.privateKey,
          challenge.challengeId,
          challenge.challenge,
        ),
      ),
      ...overrides,
    };
    return {
      challenge,
      payload,
      response: await app.inject({
        method: "POST",
        url: "/auth/login",
        payload,
      }),
    };
  }

  it("logs in and supports authenticated user keys and logout", async () => {
    const { response } = await login();
    expect(response.statusCode).toBe(200);
    const token = response.json().token;
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/me",
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/users/${identityPublicKey}/keys`,
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/users/${"00".repeat(32)}/keys`,
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/auth/logout",
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/me",
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(401);
  });
  it("rejects reused, expired, invalid, and substituted credentials identically", async () => {
    const good = await login();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/auth/login",
          payload: good.payload,
        })
      ).statusCode,
    ).toBe(401);
    for (const overrides of [
      { signature: "00".repeat(64) },
      {
        signature: bytesToHex(
          signAuth(
            deriveKeys(
              "legal winner thank year wave sausage worth useful legal winner thank yellow",
            ).identity.privateKey,
            good.challenge.challengeId,
            good.challenge.challenge,
          ),
        ),
      },
      { encryptionPublicKey: "00".repeat(32) },
    ]) {
      const attempt = await login(overrides);
      expect(attempt.response.statusCode).toBe(401);
      expect(attempt.response.json()).toEqual({ error: "invalid_credentials" });
    }
    const expired = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      payload: {},
    });
    const expiredBody = expired.json();
    clock += 61_000;
    const expiredLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        challengeId: expiredBody.challengeId,
        identityPublicKey,
        encryptionPublicKey,
        keyBindingSignature: bytesToHex(
          signKeyBinding(keys.identity.privateKey, keys.encryption.publicKey),
        ),
        signature: bytesToHex(
          signAuth(
            keys.identity.privateKey,
            expiredBody.challengeId,
            expiredBody.challenge,
          ),
        ),
      },
    });
    expect(expiredLogin.statusCode).toBe(401);
  });
  it("requires valid bearer tokens", async () => {
    expect((await app.inject({ method: "GET", url: "/me" })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/me",
          headers: { authorization: "Bearer invalid" },
        })
      ).statusCode,
    ).toBe(401);
  });
});
