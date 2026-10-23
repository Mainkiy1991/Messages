import { createHash, randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { Pool } from "pg";
import {
  hexToBytes,
  userIdFromPublicKey,
  verifyAuth,
  verifyKeyBinding,
} from "@messages/crypto";
import { z } from "zod";
import { loadConfig } from "./config.js";

const challengeTtl = 60_000;
const sessionTtl = 30 * 24 * 60 * 60 * 1000;
const challengeSchema = z.object({}).strict();
const loginSchema = z.object({
  challengeId: z.string().regex(/^[0-9a-f]{32}$/u),
  identityPublicKey: z.string().regex(/^[0-9a-f]{64}$/u),
  encryptionPublicKey: z.string().regex(/^[0-9a-f]{64}$/u),
  keyBindingSignature: z.string().regex(/^[0-9a-f]{128}$/u),
  signature: z.string().regex(/^[0-9a-f]{128}$/u),
});
const challenges = new Map<string, { challenge: string; expiresAt: number }>();

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  return header && /^Bearer [A-Za-z0-9_-]{43}$/u.test(header)
    ? header.slice(7)
    : null;
}

export async function buildApp(
  options: { databaseUrl?: string; now?: () => number } = {},
): Promise<FastifyInstance> {
  const config = loadConfig({
    ...process.env,
    DATABASE_URL:
      options.databaseUrl ??
      process.env.DATABASE_URL ??
      "postgres://localhost/messages",
  });
  const now = options.now ?? Date.now;
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const app = Fastify({
    logger: {
      redact: ["req.headers.authorization", "req.body", "req.headers.cookie"],
    },
  });
  app.setErrorHandler((_error, _request, reply) => {
    return reply.code(500).send({ error: "internal_error" });
  });
  app.addHook("onClose", async () => {
    clearInterval(cleanup);
    await pool.end();
  });
  await app.register(cors, { origin: config.WEB_ORIGIN });
  await app.register(rateLimit, { global: false });
  app.addHook("preHandler", async (request, reply) => {
    if (
      request.url !== "/me" &&
      !request.url.startsWith("/users/") &&
      request.url !== "/auth/logout"
    )
      return;
    const token = bearerToken(request);
    if (!token) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    const result = await pool.query(
      "SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at > now()",
      [hashToken(token)],
    );
    if (!result.rowCount) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    request.headers["x-auth-user-id"] = result.rows[0].user_id as string;
    await pool.query("UPDATE users SET last_seen_at=now() WHERE id=$1", [
      result.rows[0].user_id,
    ]);
  });
  const cleanup = setInterval(() => {
    const current = now();
    for (const [id, value] of challenges)
      if (value.expiresAt <= current) challenges.delete(id);
  }, 15_000);
  cleanup.unref();

  app.get("/health", async () => ({ status: "ok" }));
  app.post(
    "/auth/challenge",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (_request, reply) => {
      if (!challengeSchema.safeParse(_request.body ?? {}).success)
        return reply.code(400).send({ error: "invalid_request" });
      const current = now();
      for (const [id, entry] of challenges)
        if (entry.expiresAt <= current) challenges.delete(id);
      if (challenges.size >= 10_000)
        return reply.code(503).send({ error: "temporarily_unavailable" });
      const challengeId = randomBytes(16).toString("hex");
      const challenge = randomBytes(32).toString("hex");
      const expiresAt = current + challengeTtl;
      challenges.set(challengeId, { challenge, expiresAt });
      return {
        challengeId,
        challenge,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },
  );

  app.post(
    "/auth/login",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(401).send({ error: "invalid_credentials" });
      const input = parsed.data;
      const pending = challenges.get(input.challengeId);
      challenges.delete(input.challengeId);
      if (!pending || pending.expiresAt <= now())
        return reply.code(401).send({ error: "invalid_credentials" });
      const identity = hexToBytes(input.identityPublicKey);
      const encryption = hexToBytes(input.encryptionPublicKey);
      const signature = hexToBytes(input.signature);
      const binding = hexToBytes(input.keyBindingSignature);
      if (
        !verifyAuth(
          identity,
          input.challengeId,
          pending.challenge,
          signature,
        ) ||
        !verifyKeyBinding(identity, encryption, binding)
      ) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }
      const userId = userIdFromPublicKey(identity);
      const expiresAt = new Date(now() + sessionTtl);
      const token = randomBytes(32).toString("base64url");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO users(id, encryption_public_key, key_binding_signature, last_seen_at)
        VALUES($1,$2,$3,now()) ON CONFLICT(id) DO UPDATE SET encryption_public_key=EXCLUDED.encryption_public_key,
        key_binding_signature=EXCLUDED.key_binding_signature,last_seen_at=now()`,
          [userId, input.encryptionPublicKey, input.keyBindingSignature],
        );
        await client.query(
          "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
          [hashToken(token), userId, expiresAt],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return { token, expiresAt: expiresAt.toISOString(), userId };
    },
  );

  app.post(
    "/auth/logout",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const token = bearerToken(request);
      if (!token) return reply.code(401).send({ error: "unauthorized" });
      await pool.query("DELETE FROM sessions WHERE token_hash=$1", [
        hashToken(token),
      ]);
      return reply.code(204).send();
    },
  );
  app.get("/me", async (request) => {
    const userId = request.headers["x-auth-user-id"] as string;
    const result = await pool.query(
      'SELECT id AS "userId", encryption_public_key AS "encryptionPublicKey", key_binding_signature AS "keyBindingSignature" FROM users WHERE id=$1',
      [userId],
    );
    return result.rows[0];
  });
  app.get<{ Params: { userId: string } }>(
    "/users/:userId/keys",
    async (request, reply) => {
      if (!/^[0-9a-f]{64}$/u.test(request.params.userId))
        return reply.code(404).send({ error: "not_found" });
      const result = await pool.query(
        'SELECT id AS "userId", encryption_public_key AS "encryptionPublicKey", key_binding_signature AS "keyBindingSignature" FROM users WHERE id=$1',
        [request.params.userId],
      );
      return result.rows[0] ?? reply.code(404).send({ error: "not_found" });
    },
  );
  return app;
}
