import { createHash, randomBytes } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { Pool, type PoolClient } from "pg";
import {
  deviceIdFromPublicKey,
  hexToBytes,
  userIdFromPublicKey,
  verifyAuth,
  verifyDeviceAuth,
  verifyDeviceRegistration,
  verifyKeyBinding,
} from "@messages/crypto";
import { z } from "zod";
import { loadConfig } from "./config.js";
import {
  closeWebSocketsForToken,
  conversationClearedSchema,
  decodeBase64Size,
  messageDeletedSchema,
  messageUpdatedSchema,
  messagesErasedSchema,
  registerWebSocket,
} from "./ws.js";
import { MAX_CONVERSATIONS } from "@messages/shared";

declare module "fastify" {
  interface FastifyRequest {
    userId: string | null;
    deviceId: string | null;
  }
}

const challengeTtl = 60_000;
const sessionTtl = 30 * 24 * 60 * 60 * 1000;
const sessionCleanupInterval = 60 * 60 * 1000;
const challengeSchema = z.object({}).strict();
const loginSchema = z.object({
  challengeId: z.string().regex(/^[0-9a-f]{32}$/u),
  identityPublicKey: z.string().regex(/^[0-9a-f]{64}$/u),
  encryptionPublicKey: z.string().regex(/^[0-9a-f]{64}$/u),
  keyBindingSignature: z.string().regex(/^[0-9a-f]{128}$/u),
  signature: z.string().regex(/^[0-9a-f]{128}$/u),
});
const deviceRegisterSchema = z
  .object({
    challengeId: z.string().regex(/^[0-9a-f]{32}$/u),
    identityPublicKey: z.string().regex(/^[0-9a-f]{64}$/u),
    encryptionPublicKey: z.string().regex(/^[0-9a-f]{64}$/u),
    keyBindingSignature: z.string().regex(/^[0-9a-f]{128}$/u),
    devicePublicKey: z.string().regex(/^[0-9a-f]{64}$/u),
    deviceLabel: z
      .string()
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
      )
      .max(512),
    signature: z.string().regex(/^[0-9a-f]{128}$/u),
  })
  .strict();
const deviceLoginSchema = z
  .object({
    challengeId: z.string().regex(/^[0-9a-f]{32}$/u),
    deviceId: z.string().regex(/^[0-9a-f]{64}$/u),
    signature: z.string().regex(/^[0-9a-f]{128}$/u),
  })
  .strict();
const historyQuerySchema = z
  .object({
    before: z
      .string()
      .refine(
        (value) =>
          /^\d{1,19}$/u.test(value) && BigInt(value) <= 9223372036854775807n,
      )
      .optional(),
    after: z
      .string()
      .refine(
        (value) =>
          /^\d{1,19}$/u.test(value) && BigInt(value) <= 9223372036854775807n,
      )
      .optional(),
    changedAfter: z
      .string()
      .refine(
        (value) =>
          /^\d{1,19}$/u.test(value) && BigInt(value) <= 9223372036854775807n,
      )
      .optional(),
    limit: z
      .string()
      .regex(/^\d+$/u)
      .optional()
      .transform((value) => (value === undefined ? 50 : Number(value)))
      .refine((value) => value >= 1 && value <= 100),
  })
  .strict();
const contactsSchema = z
  .object({
    baseVersion: z
      .string()
      .refine(
        (value) =>
          /^\d{1,19}$/u.test(value) && BigInt(value) <= 9223372036854775806n,
      ),
    blob: z
      .string()
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
      ),
  })
  .strict();
const challenges = new Map<string, { challenge: string; expiresAt: number }>();
const emptyBodySchema = z.object({}).strict();
const base64Schema = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);
const updateMessageBodySchema = z
  .object({ ciphertext: base64Schema, senderCopy: base64Schema })
  .strict();
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const eraseMessageSql = `UPDATE messages
  SET ciphertext='', sender_copy='', deleted_at=now(), change_seq=nextval('messages_change_seq')`;
const updateMessageSql = `UPDATE messages
  SET ciphertext=$3, sender_copy=$4, change_seq=nextval('messages_change_seq')`;
const clearConversationSql = `WITH maximum AS (
   SELECT max(seq::bigint) AS seq FROM messages
   WHERE (sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1)
 ), cleared AS (
   INSERT INTO conversation_clears(user_id, peer_id, cleared_before_seq, hidden)
   SELECT $1, $2, seq, $3 FROM maximum WHERE seq IS NOT NULL
   ON CONFLICT(user_id, peer_id) DO UPDATE
     SET cleared_before_seq=GREATEST(conversation_clears.cleared_before_seq, EXCLUDED.cleared_before_seq),
         hidden=EXCLUDED.hidden,
         updated_at=now()
   RETURNING cleared_before_seq::text AS "clearedBeforeSeq"
 )
 SELECT COALESCE((SELECT "clearedBeforeSeq" FROM cleared), '0') AS "clearedBeforeSeq"`;

async function clearConversation(
  database: Pool | PoolClient,
  userId: string,
  peerId: string,
  hidden: boolean,
): Promise<string> {
  const result = await database.query<{ clearedBeforeSeq: string }>(
    clearConversationSql,
    [userId, peerId, hidden],
  );
  return result.rows[0]!.clearedBeforeSeq;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  return header && /^Bearer [A-Za-z0-9_-]{43}$/u.test(header)
    ? header.slice(7)
    : null;
}

export async function buildApp(options: {
  databaseUrl: string;
  now?: () => number;
  trustProxy?: boolean;
  wsAuthTimeoutMs?: number;
  wsBatchSize?: number;
}): Promise<FastifyInstance> {
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: options.databaseUrl,
    TRUST_PROXY:
      options.trustProxy === undefined
        ? process.env.TRUST_PROXY
        : String(options.trustProxy),
  });
  const now = options.now ?? Date.now;
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: 10_000,
  });
  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    logger: {
      redact: ["req.headers.authorization", "req.body", "req.headers.cookie"],
    },
  });
  app.decorateRequest("userId", null);
  app.decorateRequest("deviceId", null);
  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, "Request failed");
      return reply.code(500).send({ error: "internal_error" });
    }

    const errorCode =
      statusCode === 400
        ? "invalid_request"
        : statusCode === 401
          ? "unauthorized"
          : statusCode === 404
            ? "not_found"
            : statusCode === 429
              ? "rate_limited"
              : "request_error";
    return reply.code(statusCode).send({ error: errorCode });
  });
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && !config.ALLOWED_ORIGINS.includes(origin)) {
      return reply.code(403).send({ error: "origin_forbidden" });
    }
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });
  await app.register(cors, {
    origin: (requestOrigin, callback) => {
      callback(
        null,
        requestOrigin && config.ALLOWED_ORIGINS.includes(requestOrigin)
          ? requestOrigin
          : false,
      );
    },
    methods: ["GET", "HEAD", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type"],
  });
  await app.register(rateLimit, { global: false });

  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void | FastifyReply> {
    const token = bearerToken(request);
    if (!token) {
      await reply.code(401).send({ error: "unauthorized" });
      return reply;
    }
    const result = await pool.query<{
      user_id: string;
      device_id: string | null;
    }>(
      "SELECT user_id, device_id FROM sessions WHERE token_hash=$1 AND expires_at > now()",
      [hashToken(token)],
    );
    if (!result.rowCount) {
      await reply.code(401).send({ error: "unauthorized" });
      return reply;
    }
    request.userId = result.rows[0]!.user_id;
    request.deviceId = result.rows[0]!.device_id;
    await pool.query("UPDATE users SET last_seen_at=now() WHERE id=$1", [
      request.userId,
    ]);
  }

  try {
    await pool.query("DELETE FROM sessions WHERE expires_at < now()");
  } catch {
    await pool.end().catch(() => undefined);
    throw new Error("Не удалось подключиться к базе данных");
  }
  const sessionCleanup = setInterval(() => {
    void pool
      .query("DELETE FROM sessions WHERE expires_at < now()")
      .catch((error: unknown) => {
        app.log.error({ err: error }, "Expired session cleanup failed");
      });
  }, sessionCleanupInterval);
  sessionCleanup.unref();

  const cleanupChallenges = setInterval(() => {
    const current = now();
    for (const [id, value] of challenges) {
      if (value.expiresAt <= current) challenges.delete(id);
    }
  }, 15_000);
  cleanupChallenges.unref();
  app.addHook("onClose", async () => {
    clearInterval(sessionCleanup);
    clearInterval(cleanupChallenges);
    await pool.end();
  });

  const messageHub = await registerWebSocket(app, pool, {
    origins: config.ALLOWED_ORIGINS,
    authTimeoutMs: options.wsAuthTimeoutMs,
    batchSize: options.wsBatchSize,
  });
  app.get(
    "/health",
    { config: { rateLimit: false }, logLevel: "silent" },
    async () => ({ status: "ok" }),
  );
  app.post(
    "/auth/challenge",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!challengeSchema.safeParse(request.body ?? {}).success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const current = now();
      for (const [id, entry] of challenges) {
        if (entry.expiresAt <= current) challenges.delete(id);
      }
      if (challenges.size >= 10_000) {
        return reply.code(503).send({ error: "temporarily_unavailable" });
      }
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
      if (!parsed.success) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }
      const input = parsed.data;
      const pending = challenges.get(input.challengeId);
      challenges.delete(input.challengeId);
      if (!pending || pending.expiresAt <= now()) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }
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
           VALUES($1,$2,$3,now()) ON CONFLICT(id) DO UPDATE SET
           encryption_public_key=EXCLUDED.encryption_public_key,
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
    "/auth/device/register",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = deviceRegisterSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }
      const input = parsed.data;
      const pending = challenges.get(input.challengeId);
      challenges.delete(input.challengeId);
      if (!pending || pending.expiresAt <= now()) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      const identity = hexToBytes(input.identityPublicKey);
      const encryption = hexToBytes(input.encryptionPublicKey);
      const devicePublicKey = hexToBytes(input.devicePublicKey);
      const signature = hexToBytes(input.signature);
      const binding = hexToBytes(input.keyBindingSignature);
      if (
        !verifyDeviceRegistration(
          identity,
          input.challengeId,
          pending.challenge,
          devicePublicKey,
          signature,
        ) ||
        !verifyKeyBinding(identity, encryption, binding)
      ) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      const userId = userIdFromPublicKey(identity);
      const deviceId = deviceIdFromPublicKey(devicePublicKey);
      const expiresAt = new Date(now() + sessionTtl);
      const token = randomBytes(32).toString("base64url");
      const client = await pool.connect();
      const closedHashes: string[] = [];
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO users(id, encryption_public_key, key_binding_signature, last_seen_at)
           VALUES($1,$2,$3,now()) ON CONFLICT(id) DO UPDATE SET
           encryption_public_key=EXCLUDED.encryption_public_key,
           key_binding_signature=EXCLUDED.key_binding_signature,last_seen_at=now()`,
          [userId, input.encryptionPublicKey, input.keyBindingSignature],
        );

        const existing = await client.query<{
          user_id: string;
          revoked_at: Date | null;
        }>("SELECT user_id, revoked_at FROM devices WHERE device_id=$1", [
          deviceId,
        ]);
        if (existing.rowCount) {
          const row = existing.rows[0]!;
          if (row.user_id !== userId) {
            await client.query("ROLLBACK");
            return reply.code(401).send({ error: "invalid_credentials" });
          }
          if (row.revoked_at) {
            await client.query("ROLLBACK");
            return reply.code(403).send({ error: "device_revoked" });
          }
          await client.query(
            `UPDATE devices SET label_ciphertext=$2, last_seen_at=now()
             WHERE device_id=$1`,
            [deviceId, input.deviceLabel],
          );
        } else {
          await client.query(
            `INSERT INTO devices(device_id,user_id,label_ciphertext)
             VALUES($1,$2,$3)`,
            [deviceId, userId, input.deviceLabel],
          );
        }

        const activeCount = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM devices WHERE user_id=$1 AND revoked_at IS NULL",
          [userId],
        );
        const excess = Number(activeCount.rows[0]!.count) - 20;
        if (excess > 0) {
          const oldest = await client.query<{ device_id: string }>(
            `SELECT device_id FROM devices
             WHERE user_id=$1 AND revoked_at IS NULL AND device_id<>$2
             ORDER BY last_seen_at ASC, created_at ASC
             LIMIT $3`,
            [userId, deviceId, excess],
          );
          for (const row of oldest.rows) {
            const removed = await client.query<{ token_hash: string }>(
              "DELETE FROM sessions WHERE device_id=$1 RETURNING token_hash",
              [row.device_id],
            );
            for (const removedRow of removed.rows) {
              if (removedRow.token_hash)
                closedHashes.push(removedRow.token_hash);
            }
            await client.query(
              "UPDATE devices SET revoked_at=now() WHERE device_id=$1",
              [row.device_id],
            );
          }
        }

        await client.query(
          `DELETE FROM devices
           WHERE device_id IN (
             SELECT device_id FROM devices
             WHERE user_id=$1 AND revoked_at IS NOT NULL
             ORDER BY revoked_at DESC
             OFFSET 100
           )`,
          [userId],
        );
        await client.query(
          "INSERT INTO sessions(token_hash,user_id,device_id,expires_at) VALUES($1,$2,$3,$4)",
          [hashToken(token), userId, deviceId, expiresAt],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      for (const tokenHash of closedHashes) {
        closeWebSocketsForToken(app, tokenHash);
      }
      return { token, expiresAt: expiresAt.toISOString(), userId, deviceId };
    },
  );

  app.post(
    "/auth/device/login",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = deviceLoginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }
      const input = parsed.data;
      const pending = challenges.get(input.challengeId);
      challenges.delete(input.challengeId);
      if (!pending || pending.expiresAt <= now()) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      const device = await pool.query<{
        user_id: string;
        revoked_at: Date | null;
      }>("SELECT user_id, revoked_at FROM devices WHERE device_id=$1", [
        input.deviceId,
      ]);
      if (!device.rowCount) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }
      const row = device.rows[0]!;
      const valid = verifyDeviceAuth(
        hexToBytes(input.deviceId),
        input.challengeId,
        pending.challenge,
        hexToBytes(input.signature),
      );
      if (!valid) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }
      if (row.revoked_at) {
        return reply.code(403).send({ error: "device_revoked" });
      }

      const expiresAt = new Date(now() + sessionTtl);
      const token = randomBytes(32).toString("base64url");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "UPDATE devices SET last_seen_at=now() WHERE device_id=$1",
          [input.deviceId],
        );
        await client.query("UPDATE users SET last_seen_at=now() WHERE id=$1", [
          row.user_id,
        ]);
        await client.query(
          "INSERT INTO sessions(token_hash,user_id,device_id,expires_at) VALUES($1,$2,$3,$4)",
          [hashToken(token), row.user_id, input.deviceId, expiresAt],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      return {
        token,
        expiresAt: expiresAt.toISOString(),
        userId: row.user_id,
        deviceId: input.deviceId,
      };
    },
  );

  app.post(
    "/auth/logout",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const token = bearerToken(request);
      if (!token) return reply.code(401).send({ error: "unauthorized" });
      await pool.query("DELETE FROM sessions WHERE token_hash=$1", [
        hashToken(token),
      ]);
      closeWebSocketsForToken(app, hashToken(token));
      return reply.code(204).send();
    },
  );
  app.get("/me", { preHandler: authenticate }, async (request) => {
    const result = await pool.query(
      'SELECT id AS "userId", encryption_public_key AS "encryptionPublicKey", key_binding_signature AS "keyBindingSignature" FROM users WHERE id=$1',
      [request.userId],
    );
    return result.rows[0];
  });
  app.get(
    "/devices",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request) => {
      const result = await pool.query<{
        device_id: string;
        label_ciphertext: string;
        created_at: Date;
        last_seen_at: Date;
      }>(
        `SELECT device_id, label_ciphertext, created_at, last_seen_at
         FROM devices
         WHERE user_id=$1 AND revoked_at IS NULL
         ORDER BY last_seen_at DESC, created_at DESC`,
        [request.userId],
      );
      return {
        devices: result.rows.map((row) => ({
          deviceId: row.device_id,
          labelCiphertext: row.label_ciphertext,
          createdAt: row.created_at.toISOString(),
          lastSeenAt: row.last_seen_at.toISOString(),
          current: row.device_id === request.deviceId,
        })),
      };
    },
  );

  app.delete<{ Params: { deviceId: string } }>(
    "/devices/:deviceId",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!/^[0-9a-f]{64}$/u.test(request.params.deviceId)) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      if (request.params.deviceId === request.deviceId) {
        return reply.code(409).send({ error: "current_device" });
      }
      const existing = await pool.query<{
        user_id: string;
        revoked_at: Date | null;
      }>("SELECT user_id, revoked_at FROM devices WHERE device_id=$1", [
        request.params.deviceId,
      ]);
      if (!existing.rowCount || existing.rows[0]!.user_id !== request.userId) {
        return reply.code(404).send({ error: "not_found" });
      }
      if (existing.rows[0]!.revoked_at) {
        return reply.code(204).send();
      }

      const client = await pool.connect();
      const closedHashes: string[] = [];
      try {
        await client.query("BEGIN");
        await client.query(
          "UPDATE devices SET revoked_at=now() WHERE device_id=$1",
          [request.params.deviceId],
        );
        const removed = await client.query<{ token_hash: string }>(
          "DELETE FROM sessions WHERE device_id=$1 RETURNING token_hash",
          [request.params.deviceId],
        );
        for (const row of removed.rows) closedHashes.push(row.token_hash);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      for (const tokenHash of closedHashes) {
        closeWebSocketsForToken(app, tokenHash);
      }
      return reply.code(204).send();
    },
  );

  app.post(
    "/devices/revoke-others",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!emptyBodySchema.safeParse(request.body ?? {}).success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const currentToken = bearerToken(request);
      const currentHash = currentToken ? hashToken(currentToken) : null;
      const client = await pool.connect();
      const closedHashes: string[] = [];
      let revoked = 0;
      let endedLegacySessions = 0;
      try {
        await client.query("BEGIN");
        const devices = await client.query<{ device_id: string }>(
          `SELECT device_id FROM devices
           WHERE user_id=$1 AND revoked_at IS NULL
             AND ($2::text IS NULL OR device_id<>$2)`,
          [request.userId, request.deviceId],
        );
        for (const row of devices.rows) {
          await client.query(
            "UPDATE devices SET revoked_at=now() WHERE device_id=$1",
            [row.device_id],
          );
          const removed = await client.query<{ token_hash: string }>(
            "DELETE FROM sessions WHERE device_id=$1 RETURNING token_hash",
            [row.device_id],
          );
          for (const removedRow of removed.rows) {
            closedHashes.push(removedRow.token_hash);
          }
          revoked++;
        }
        const legacy = await client.query<{ token_hash: string }>(
          `DELETE FROM sessions
           WHERE user_id=$1 AND device_id IS NULL
             AND ($2::text IS NULL OR token_hash<>$2)
           RETURNING token_hash`,
          [request.userId, currentHash],
        );
        endedLegacySessions = legacy.rowCount ?? 0;
        for (const row of legacy.rows) closedHashes.push(row.token_hash);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      for (const tokenHash of closedHashes) {
        closeWebSocketsForToken(app, tokenHash);
      }
      return { revoked, endedLegacySessions };
    },
  );
  app.get("/conversations", { preHandler: authenticate }, async (request) => {
    const result = await pool.query(
      `WITH visible_conversations AS (
         SELECT CASE WHEN m.sender_id=$1 THEN m.recipient_id ELSE m.sender_id END AS peer_id,
                max(m.seq::bigint) AS last_seq,
                (array_agg(m.created_at ORDER BY m.seq::bigint DESC))[1] AS last_created_at,
                max(m.change_seq) AS last_change_seq,
                false AS cleared
         FROM messages m
         LEFT JOIN conversation_clears c
           ON c.user_id=$1 AND c.peer_id=CASE WHEN m.sender_id=$1 THEN m.recipient_id ELSE m.sender_id END
         WHERE (m.sender_id=$1 OR m.recipient_id=$1)
           AND m.seq::bigint > COALESCE(c.cleared_before_seq, 0::bigint)
         GROUP BY CASE WHEN m.sender_id=$1 THEN m.recipient_id ELSE m.sender_id END
       ), empty_cleared_conversations AS (
         SELECT c.peer_id, c.cleared_before_seq AS last_seq, c.updated_at AS last_created_at,
                0::bigint AS last_change_seq, true AS cleared
         FROM conversation_clears c
         WHERE c.user_id=$1 AND c.hidden=false
           AND NOT EXISTS (
             SELECT 1 FROM messages m
             WHERE ((m.sender_id=$1 AND m.recipient_id=c.peer_id)
                 OR (m.sender_id=c.peer_id AND m.recipient_id=$1))
               AND m.seq::bigint > c.cleared_before_seq
           )
       ), conversations AS (
         SELECT * FROM visible_conversations
         UNION ALL
         SELECT * FROM empty_cleared_conversations
       )
       SELECT peer_id AS "peerId", last_seq::text AS "lastSeq",
              last_created_at AS "lastCreatedAt",
              COALESCE(last_change_seq, 0)::text AS "lastChangeSeq", cleared
       FROM conversations
       ORDER BY last_seq DESC
       LIMIT $2`,
      [request.userId, MAX_CONVERSATIONS],
    );
    const cleared = await pool.query(
      `SELECT peer_id AS "peerId", cleared_before_seq::text AS "clearedBeforeSeq", hidden
       FROM conversation_clears WHERE user_id=$1
       ORDER BY updated_at DESC LIMIT 500`,
      [request.userId],
    );
    return { conversations: result.rows, cleared: cleared.rows };
  });
  app.delete<{
    Params: { peerId: string };
  }>(
    "/conversations/:peerId",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!/^[0-9a-f]{64}$/u.test(request.params.peerId))
        return reply.code(400).send({ error: "invalid_request" });
      const clearedBeforeSeq = await clearConversation(
        pool,
        request.userId!,
        request.params.peerId,
        false,
      );
      const frame = conversationClearedSchema.parse({
        type: "conversation_cleared",
        peerId: request.params.peerId,
        clearedBeforeSeq,
        hidden: false,
      });
      messageHub.sendToUser(request.userId!, frame);
      return { clearedBeforeSeq };
    },
  );
  app.post<{
    Params: { peerId: string };
  }>(
    "/conversations/:peerId/erase",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!/^[0-9a-f]{64}$/u.test(request.params.peerId))
        return reply.code(400).send({ error: "invalid_request" });
      if (!emptyBodySchema.safeParse(request.body ?? {}).success)
        return reply.code(400).send({ error: "invalid_request" });
      const userId = request.userId!;
      const peerId = request.params.peerId;
      let erasedRows: Array<{ seq: string; changeSeq: string }> = [];
      let clearedBeforeSeq = "0";
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const erased = await client.query<{ seq: string; changeSeq: string }>(
          `${eraseMessageSql}
           WHERE sender_id=$1 AND recipient_id=$2 AND deleted_at IS NULL
           RETURNING seq::text AS seq, change_seq::text AS "changeSeq"`,
          [userId, peerId],
        );
        erasedRows = erased.rows;
        clearedBeforeSeq = await clearConversation(
          client,
          userId,
          peerId,
          true,
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      messageHub.sendToUser(
        userId,
        conversationClearedSchema.parse({
          type: "conversation_cleared",
          peerId,
          clearedBeforeSeq,
          hidden: true,
        }),
      );
      if (peerId !== userId && erasedRows.length > 0) {
        let upToSeq = 0n;
        let changeSeq = 0n;
        for (const row of erasedRows) {
          if (BigInt(row.seq) > upToSeq) upToSeq = BigInt(row.seq);
          if (BigInt(row.changeSeq) > changeSeq)
            changeSeq = BigInt(row.changeSeq);
        }
        messageHub.sendToUser(
          peerId,
          messagesErasedSchema.parse({
            type: "messages_erased",
            from: userId,
            to: peerId,
            upToSeq: upToSeq.toString(),
            changeSeq: changeSeq.toString(),
          }),
        );
      }
      return { erased: erasedRows.length, clearedBeforeSeq };
    },
  );
  app.delete<{
    Params: { id: string };
  }>(
    "/messages/:id",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!uuidPattern.test(request.params.id))
        return reply.code(400).send({ error: "invalid_request" });
      const updated = await pool.query<{
        id: string;
        seq: string;
        recipient_id: string;
        changeSeq: string;
      }>(
        `${eraseMessageSql}
         WHERE id=$1 AND sender_id=$2 AND deleted_at IS NULL
         RETURNING id, seq::text AS seq, recipient_id, change_seq::text AS "changeSeq"`,
        [request.params.id, request.userId],
      );
      if (!updated.rowCount) {
        const own = await pool.query(
          "SELECT 1 FROM messages WHERE id=$1 AND sender_id=$2",
          [request.params.id, request.userId],
        );
        if (!own.rowCount) return reply.code(404).send({ error: "not_found" });
        return reply.code(204).send();
      }
      const row = updated.rows[0]!;
      const frame = messageDeletedSchema.parse({
        type: "message_deleted",
        id: row.id,
        from: request.userId,
        to: row.recipient_id,
        seq: row.seq,
        changeSeq: row.changeSeq,
      });
      messageHub.sendToUser(row.recipient_id, frame);
      if (row.recipient_id !== request.userId)
        messageHub.sendToUser(request.userId!, frame);
      return reply.code(204).send();
    },
  );
  app.put<{
    Params: { id: string };
  }>(
    "/messages/:id",
    {
      preHandler: authenticate,
      bodyLimit: 128 * 1024,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!uuidPattern.test(request.params.id))
        return reply.code(400).send({ error: "invalid_request" });
      const parsed = updateMessageBodySchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ error: "invalid_request" });
      const { ciphertext, senderCopy } = parsed.data;
      if (
        decodeBase64Size(ciphertext) <= 0 ||
        decodeBase64Size(ciphertext) > 64 * 1024 ||
        decodeBase64Size(senderCopy) <= 0 ||
        decodeBase64Size(senderCopy) > 64 * 1024
      )
        return reply.code(400).send({ error: "invalid_request" });
      const updated = await pool.query<{
        id: string;
        seq: string;
        recipient_id: string;
        changeSeq: string;
      }>(
        `${updateMessageSql}
         WHERE id=$1 AND sender_id=$2 AND deleted_at IS NULL
         RETURNING id, seq::text AS seq, recipient_id, change_seq::text AS "changeSeq"`,
        [request.params.id, request.userId, ciphertext, senderCopy],
      );
      if (!updated.rowCount) {
        const own = await pool.query(
          "SELECT 1 FROM messages WHERE id=$1 AND sender_id=$2",
          [request.params.id, request.userId],
        );
        if (!own.rowCount) return reply.code(404).send({ error: "not_found" });
        return reply.code(409).send({ error: "message_deleted" });
      }
      const row = updated.rows[0]!;
      const base = {
        type: "message_updated" as const,
        id: row.id,
        from: request.userId!,
        to: row.recipient_id,
        seq: row.seq,
        changeSeq: row.changeSeq,
      };
      if (row.recipient_id !== request.userId) {
        messageHub.sendToUser(
          row.recipient_id,
          messageUpdatedSchema.parse({ ...base, payload: ciphertext }),
        );
      }
      messageHub.sendToUser(
        request.userId!,
        messageUpdatedSchema.parse({ ...base, payload: senderCopy }),
      );
      return reply.code(204).send();
    },
  );
  app.get<{
    Params: { peerId: string };
    Querystring: {
      before?: string;
      after?: string;
      changedAfter?: string;
      limit?: string;
    };
  }>(
    "/history/:peerId",
    { preHandler: authenticate },
    async (request, reply) => {
      if (!/^[0-9a-f]{64}$/u.test(request.params.peerId))
        return reply.code(400).send({ error: "invalid_request" });
      const parsed = historyQuerySchema.safeParse(request.query);
      if (!parsed.success)
        return reply.code(400).send({ error: "invalid_request" });
      const { before, after, changedAfter, limit } = parsed.data;
      if ((before && after) || (changedAfter && (before || after)))
        return reply.code(400).send({ error: "invalid_request" });
      const forward = !!after;
      const rows = await pool.query(
        `SELECT id, seq::text AS seq, sender_id, client_msg_id AS "clientMsgId",
                CASE WHEN sender_id=$1 THEN sender_copy ELSE ciphertext END AS payload,
                created_at AS "createdAt", delivered_at AS "deliveredAt",
                change_seq::text AS "changeSeq", deleted_at IS NOT NULL AS deleted
         FROM messages WHERE ((sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1))
           AND seq::bigint > COALESCE(
             (SELECT cleared_before_seq FROM conversation_clears WHERE user_id=$1 AND peer_id=$2),
             0::bigint
           )
           AND ($3::bigint IS NULL OR seq::bigint < $3::bigint)
           AND ($4::bigint IS NULL OR seq::bigint > $4::bigint)
           AND ($6::bigint IS NULL OR (change_seq IS NOT NULL AND change_seq > $6::bigint))
         ORDER BY ${changedAfter ? "change_seq::bigint ASC" : `seq::bigint ${forward ? "ASC" : "DESC"}`} LIMIT $5`,
        [
          request.userId,
          request.params.peerId,
          before ?? null,
          after ?? null,
          limit + 1,
          changedAfter ?? null,
        ],
      );
      const hasMore = rows.rows.length > limit;
      const selectedRows = rows.rows.slice(0, limit);
      if (!forward && !changedAfter) selectedRows.reverse();
      const messages = selectedRows.map((row) => ({
        id: row.id,
        seq: row.seq,
        direction: row.sender_id === request.userId ? "out" : "in",
        clientMsgId: row.clientMsgId,
        payload: row.payload,
        createdAt: row.createdAt,
        deliveredAt: row.deliveredAt,
        changeSeq: row.changeSeq,
        deleted: row.deleted,
      }));
      const marker = await pool.query<{ readUpToSeq: string }>(
        `SELECT read_up_to_seq::text AS "readUpToSeq" FROM read_markers
         WHERE reader_id=$1 AND peer_id=$2`,
        [request.params.peerId, request.userId],
      );
      return {
        messages,
        hasMore,
        peerReadUpToSeq: marker.rows[0]?.readUpToSeq ?? null,
      };
    },
  );
  app.get("/contacts", { preHandler: authenticate }, async (request) => {
    const result = await pool.query(
      "SELECT version::text AS version, blob FROM contact_books WHERE user_id=$1",
      [request.userId],
    );
    return result.rowCount ? result.rows[0] : { version: "0", blob: null };
  });
  app.put(
    "/contacts",
    {
      preHandler: authenticate,
      bodyLimit: 512 * 1024,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const parsed = contactsSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ error: "invalid_request" });
      const { baseVersion, blob } = parsed.data;
      const decoded = Buffer.from(blob, "base64");
      if (
        decoded.toString("base64") !== blob ||
        decoded.length < 1 ||
        decoded.length > 256 * 1024
      )
        return reply.code(400).send({ error: "invalid_request" });
      const updated = await pool.query(
        `INSERT INTO contact_books(user_id, version, blob)
       SELECT $1, 1, $3
       WHERE $2::bigint = 0 OR EXISTS(SELECT 1 FROM contact_books WHERE user_id=$1)
       ON CONFLICT(user_id) DO UPDATE SET version=contact_books.version+1, blob=EXCLUDED.blob, updated_at=now()
       WHERE contact_books.version=$2::bigint RETURNING version::text AS version`,
        [request.userId, baseVersion, blob],
      );
      if (updated.rowCount) return { version: updated.rows[0].version };
      const current = await pool.query(
        "SELECT version::text AS version, blob FROM contact_books WHERE user_id=$1",
        [request.userId],
      );
      return reply.code(409).send({
        error: "version_conflict",
        version: current.rows[0]?.version ?? "0",
        blob: current.rows[0]?.blob ?? null,
      });
    },
  );
  app.get<{ Params: { userId: string } }>(
    "/users/:userId/keys",
    { preHandler: authenticate },
    async (request, reply) => {
      if (!/^[0-9a-f]{64}$/u.test(request.params.userId)) {
        return reply.code(404).send({ error: "not_found" });
      }
      const result = await pool.query(
        'SELECT id AS "userId", encryption_public_key AS "encryptionPublicKey", key_binding_signature AS "keyBindingSignature" FROM users WHERE id=$1',
        [request.params.userId],
      );
      return result.rows[0] ?? reply.code(404).send({ error: "not_found" });
    },
  );
  return app;
}
