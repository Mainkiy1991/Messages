import { createHash, randomBytes } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
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
import { closeWebSocketsForToken, registerWebSocket } from "./ws.js";
import { MAX_CONVERSATIONS } from "@messages/shared";

declare module "fastify" {
  interface FastifyRequest {
    userId: string | null;
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
  await app.register(cors, {
    origin: (requestOrigin, callback) => {
      callback(
        null,
        requestOrigin === config.WEB_ORIGIN ? config.WEB_ORIGIN : false,
      );
    },
    methods: ["GET", "HEAD", "POST", "PUT"],
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
    const result = await pool.query(
      "SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at > now()",
      [hashToken(token)],
    );
    if (!result.rowCount) {
      await reply.code(401).send({ error: "unauthorized" });
      return reply;
    }
    request.userId = result.rows[0].user_id as string;
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

  await registerWebSocket(app, pool, {
    origin: config.WEB_ORIGIN,
    authTimeoutMs: options.wsAuthTimeoutMs,
    batchSize: options.wsBatchSize,
  });

  app.get("/health", async () => ({ status: "ok" }));
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
  app.get("/conversations", { preHandler: authenticate }, async (request) => {
    const result = await pool.query(
      `SELECT peer_id AS "peerId", last_seq::text AS "lastSeq", last_created_at AS "lastCreatedAt"
       FROM (
         SELECT CASE WHEN sender_id=$1 THEN recipient_id ELSE sender_id END AS peer_id,
                max(seq::bigint) AS last_seq, (array_agg(created_at ORDER BY seq::bigint DESC))[1] AS last_created_at
         FROM messages WHERE sender_id=$1 OR recipient_id=$1
         GROUP BY CASE WHEN sender_id=$1 THEN recipient_id ELSE sender_id END
       ) conversations ORDER BY last_seq::bigint DESC LIMIT $2`,
      [request.userId, MAX_CONVERSATIONS],
    );
    return { conversations: result.rows };
  });
  app.get<{
    Params: { peerId: string };
    Querystring: { before?: string; after?: string; limit?: string };
  }>(
    "/history/:peerId",
    { preHandler: authenticate },
    async (request, reply) => {
      if (!/^[0-9a-f]{64}$/u.test(request.params.peerId))
        return reply.code(400).send({ error: "invalid_request" });
      const parsed = historyQuerySchema.safeParse(request.query);
      if (!parsed.success)
        return reply.code(400).send({ error: "invalid_request" });
      const { before, after, limit } = parsed.data;
      if (before && after)
        return reply.code(400).send({ error: "invalid_request" });
      const forward = !!after;
      const rows = await pool.query(
        `SELECT id, seq::text AS seq, sender_id, client_msg_id AS "clientMsgId",
                CASE WHEN sender_id=$1 THEN sender_copy ELSE ciphertext END AS payload,
                created_at AS "createdAt", delivered_at AS "deliveredAt"
         FROM messages WHERE ((sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1))
           AND ($3::bigint IS NULL OR seq::bigint < $3::bigint)
           AND ($4::bigint IS NULL OR seq::bigint > $4::bigint)
         ORDER BY seq::bigint ${forward ? "ASC" : "DESC"} LIMIT $5`,
        [
          request.userId,
          request.params.peerId,
          before ?? null,
          after ?? null,
          limit + 1,
        ],
      );
      const hasMore = rows.rows.length > limit;
      const selectedRows = rows.rows.slice(0, limit);
      if (!forward) selectedRows.reverse();
      const messages = selectedRows.map((row) => ({
        id: row.id,
        seq: row.seq,
        direction: row.sender_id === request.userId ? "out" : "in",
        clientMsgId: row.clientMsgId,
        payload: row.payload,
        createdAt: row.createdAt,
        deliveredAt: row.deliveredAt,
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
