import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bytesToHex,
  deriveKeys,
  signAuth,
  signKeyBinding,
} from "@messages/crypto";
import { buildApp } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI === "true") {
  throw new Error(
    "TEST_DATABASE_URL is required in CI; server tests cannot be skipped.",
  );
}
if (!databaseUrl) {
  console.warn(
    "Skipping server integration tests: TEST_DATABASE_URL is not set (CI requires PostgreSQL 16).",
  );
}
const { Pool } = pg;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const suite = databaseUrl ? describe : describe.skip;
const phrase =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const keys = deriveKeys(phrase);
const identityPublicKey = bytesToHex(keys.identity.publicKey);
const encryptionPublicKey = bytesToHex(keys.encryption.publicKey);

suite("server authentication (PostgreSQL)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let clock = Date.now();

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
    app = await buildApp({ databaseUrl: databaseUrl!, now: () => clock });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  async function createChallenge(target = app) {
    const response = await target.inject({
      method: "POST",
      url: "/auth/challenge",
      payload: {},
    });
    return response.json() as { challengeId: string; challenge: string };
  }

  function loginPayload(
    challenge: { challengeId: string; challenge: string },
    overrides: Record<string, unknown> = {},
  ) {
    return {
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
  }

  async function login(target = app) {
    const challenge = await createChallenge(target);
    const response = await target.inject({
      method: "POST",
      url: "/auth/login",
      payload: loginPayload(challenge),
    });
    return { challenge, response };
  }

  it("logs in and completes challenge → login → /me", async () => {
    const { response } = await login();
    expect(response.statusCode).toBe(200);
    const { token, userId } = response.json();
    expect(userId).toBe(identityPublicKey);
    const me = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().userId).toBe(userId);
  });

  it("rejects reusing a challenge", async () => {
    const challenge = await createChallenge();
    const payload = loginPayload(challenge);
    expect(
      (await app.inject({ method: "POST", url: "/auth/login", payload }))
        .statusCode,
    ).toBe(200);
    const repeated = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload,
    });
    expect(repeated.statusCode).toBe(401);
    expect(repeated.json()).toEqual({ error: "invalid_credentials" });
  });

  it("rejects an expired challenge", async () => {
    const challenge = await createChallenge();
    clock += 61_000;
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: loginPayload(challenge),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_credentials" });
  });

  it("rejects an invalid signature", async () => {
    const challenge = await createChallenge();
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: loginPayload(challenge, { signature: "00".repeat(64) }),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_credentials" });
  });

  it("rejects a signature from a different identity key", async () => {
    const challenge = await createChallenge();
    const foreignKeys = deriveKeys(
      "legal winner thank year wave sausage worth useful legal winner thank yellow",
    );
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: loginPayload(challenge, {
        signature: bytesToHex(
          signAuth(
            foreignKeys.identity.privateKey,
            challenge.challengeId,
            challenge.challenge,
          ),
        ),
      }),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_credentials" });
  });

  it("rejects encryption key substitution without a valid binding", async () => {
    const challenge = await createChallenge();
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: loginPayload(challenge, {
        encryptionPublicKey: "00".repeat(32),
      }),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_credentials" });
  });

  it("returns 401 from /me without a token", async () => {
    expect((await app.inject({ method: "GET", url: "/me" })).statusCode).toBe(
      401,
    );
  });

  it("returns 401 from /me with an invalid token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: "Bearer invalid" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns found and missing public keys", async () => {
    const { response: loginResponse } = await login();
    const token = loginResponse.json().token;
    const found = await app.inject({
      method: "GET",
      url: `/users/${identityPublicKey}/keys`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(found.statusCode).toBe(200);
    expect(found.json().userId).toBe(identityPublicKey);
    const missing = await app.inject({
      method: "GET",
      url: `/users/${"00".repeat(32)}/keys`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("invalidates a session after logout", async () => {
    const { response: loginResponse } = await login();
    const token = loginResponse.json().token;
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

  it("returns 401 for /me?x=1 without a token", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/me?x=1" })).statusCode,
    ).toBe(401);
  });

  it("ignores X-Auth-User-Id without a token, including query URLs", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/me?x=1",
      headers: { "x-auth-user-id": identityPublicKey },
    });
    expect(response.statusCode).toBe(401);
  });

  it("uses the token identity and ignores X-Auth-User-Id", async () => {
    const { response: loginResponse } = await login();
    const token = loginResponse.json().token;
    const me = await app.inject({
      method: "GET",
      url: "/me?x=1",
      headers: {
        authorization: `Bearer ${token}`,
        "x-auth-user-id": "00".repeat(32),
      },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().userId).toBe(identityPublicKey);
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      headers: { "content-type": "application/json" },
      payload: '{"invalid":',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("rate limits challenge requests after 20 in one minute", async () => {
    const rateLimitApp = await buildApp({
      databaseUrl: databaseUrl!,
      trustProxy: true,
      now: () => clock,
    });
    try {
      for (let index = 0; index < 20; index += 1) {
        const response = await rateLimitApp.inject({
          method: "POST",
          url: "/auth/challenge",
          headers: { "x-forwarded-for": "198.51.100.24" },
          payload: {},
        });
        expect(response.statusCode).toBe(200);
      }
      const limited = await rateLimitApp.inject({
        method: "POST",
        url: "/auth/challenge",
        headers: { "x-forwarded-for": "198.51.100.24" },
        payload: {},
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toEqual({ error: "rate_limited" });
    } finally {
      await rateLimitApp.close();
    }
  });
});
