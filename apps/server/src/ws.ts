import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import type { Pool } from "pg";
import WebSocket from "ws";
import { z } from "zod";
import { createMessageHub, type MessageRow } from "./messages.js";
import { MAX_CONVERSATIONS } from "@messages/shared";

const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const sendSchema = z
  .object({
    type: z.literal("send"),
    clientMsgId: z.string().regex(/^[0-9a-f]{32}$/u),
    to: z.string().regex(/^[0-9a-f]{64}$/u),
    ciphertext: z
      .string()
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
      ),
    senderCopy: z
      .string()
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
      ),
  })
  .strict();
const ackSchema = z
  .object({
    type: z.literal("ack"),
    ids: z.array(z.string().uuid()).max(200),
  })
  .strict();
const readSchema = z
  .object({
    type: z.literal("read"),
    peerId: z.string().regex(/^[0-9a-f]{64}$/u),
    upToSeq: z
      .string()
      .regex(/^\d{1,19}$/u)
      .refine((value) => {
        try {
          return BigInt(value) <= 9223372036854775807n;
        } catch {
          return false;
        }
      }),
  })
  .strict();
const presenceSubscribeSchema = z
  .object({
    type: z.literal("presence_subscribe"),
    peerIds: z
      .array(z.string().regex(/^[0-9a-f]{64}$/u))
      .max(MAX_CONVERSATIONS),
  })
  .strict();
export const conversationClearedSchema = z
  .object({
    type: z.literal("conversation_cleared"),
    peerId: z.string().regex(/^[0-9a-f]{64}$/u),
    clearedBeforeSeq: z
      .string()
      .regex(/^\d{1,19}$/u)
      .refine((value) => BigInt(value) <= 9223372036854775807n),
  })
  .strict();

type Connection = {
  socket: WebSocket;
  userId: string;
  tokenHash: string;
  alive: boolean;
  peerIds: Set<string>;
};
type WsOptions = {
  origins: string[];
  authTimeoutMs?: number;
  batchSize?: number;
  maxConnectionsPerUser?: number;
  maxPayload?: number;
};

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function decodeBase64Size(value: string): number {
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes.length : -1;
}

function clientMsgIdFromFrame(frame: unknown): string | undefined {
  if (
    frame &&
    typeof frame === "object" &&
    "clientMsgId" in frame &&
    typeof frame.clientMsgId === "string"
  ) {
    return frame.clientMsgId;
  }
  return undefined;
}

function clientMsgIdFromData(
  data: WebSocket.RawData,
  isBinary: boolean,
): string | undefined {
  if (isBinary) return undefined;
  try {
    return clientMsgIdFromFrame(JSON.parse(data.toString()));
  } catch {
    return undefined;
  }
}

function errorFrame(socket: WebSocket, code: string, clientMsgId?: string) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(
    JSON.stringify({
      type: "error",
      code,
      ...(clientMsgId ? { clientMsgId } : {}),
    }),
  );
}

export async function registerWebSocket(
  app: FastifyInstance,
  pool: Pool,
  options: WsOptions,
): Promise<ReturnType<typeof createMessageHub>> {
  const maxPayload = options.maxPayload ?? 256 * 1024;
  const batchSize = options.batchSize ?? 200;
  const maxConnections = options.maxConnectionsPerUser ?? 5;
  const hub = createMessageHub(pool, batchSize);
  const connections = new Set<Connection>();
  const perUser = new Map<string, Set<Connection>>();
  const perToken = new Map<string, Set<Connection>>();
  const readWindows = new Map<string, number[]>();
  const presenceWindows = new Map<string, number[]>();
  const lastSeenWrites = new Map<string, number>();
  const appWithWsState = app as FastifyInstance & {
    getWebSocketMemoryState?: () => {
      users: number;
      readWindows: number;
      subscribedConnections: number;
    };
  };
  if (process.env.NODE_ENV === "test") {
    appWithWsState.getWebSocketMemoryState = () => ({
      users: perUser.size,
      readWindows: readWindows.size,
      subscribedConnections: [...connections].filter(
        (connection) => connection.peerIds.size > 0,
      ).length,
    });
  }

  type PresenceTarget = { connection: Connection; peerId: string };

  async function getPresenceVisibility(
    targets: PresenceTarget[],
  ): Promise<Map<string, boolean>> {
    if (!targets.length) return new Map();
    const result = await pool.query<{
      viewer_id: string;
      peer_id: string;
      allowed: boolean;
    }>(
      `SELECT pairs.viewer_id, pairs.peer_id,
              (pairs.viewer_id <> pairs.peer_id
               AND EXISTS(SELECT 1 FROM messages m WHERE m.sender_id=pairs.viewer_id AND m.recipient_id=pairs.peer_id)
               AND EXISTS(SELECT 1 FROM messages m WHERE m.sender_id=pairs.peer_id AND m.recipient_id=pairs.viewer_id)) AS allowed
       FROM unnest($1::text[], $2::text[]) AS pairs(viewer_id, peer_id)`,
      [
        targets.map(({ connection }) => connection.userId),
        targets.map(({ peerId }) => peerId),
      ],
    );
    return new Map(
      result.rows.map((row) => [
        `${row.viewer_id}:${row.peer_id}`,
        row.allowed,
      ]),
    );
  }

  async function sendPresenceStatuses(
    targets: PresenceTarget[],
    omitHidden = false,
  ) {
    if (!targets.length) return;
    const visibility = await getPresenceVisibility(targets);
    const offlineVisibleIds = [
      ...new Set(
        targets
          .filter(
            ({ connection, peerId }) =>
              visibility.get(`${connection.userId}:${peerId}`) &&
              (perUser.get(peerId)?.size ?? 0) === 0,
          )
          .map(({ peerId }) => peerId),
      ),
    ];
    const seenRows = offlineVisibleIds.length
      ? await pool.query<{ user_id: string; last_seen_at: Date }>(
          "SELECT user_id, last_seen_at FROM presence WHERE user_id=ANY($1::text[])",
          [offlineVisibleIds],
        )
      : { rows: [] as Array<{ user_id: string; last_seen_at: Date }> };
    const lastSeen = new Map(
      seenRows.rows.map((row) => [row.user_id, row.last_seen_at.toISOString()]),
    );
    const byConnection = new Map<
      Connection,
      Array<{ peerId: string; online: boolean; lastSeenAt: string | null }>
    >();
    for (const { connection, peerId } of targets) {
      const allowed = visibility.get(`${connection.userId}:${peerId}`) ?? false;
      if (omitHidden && !allowed) continue;
      const online = allowed && (perUser.get(peerId)?.size ?? 0) > 0;
      const presences = byConnection.get(connection) ?? [];
      presences.push({
        peerId,
        online,
        lastSeenAt: allowed && !online ? (lastSeen.get(peerId) ?? null) : null,
      });
      byConnection.set(connection, presences);
    }
    for (const [connection, presences] of byConnection) {
      if (connection.socket.readyState === WebSocket.OPEN)
        connection.socket.send(JSON.stringify({ type: "presence", presences }));
    }
  }

  async function publishPresence(userId: string): Promise<void> {
    const targets = [...connections]
      .filter((subscriber) => subscriber.peerIds.has(userId))
      .map((connection) => ({ connection, peerId: userId }));
    await sendPresenceStatuses(targets, true);
  }

  async function notifyNewlyVisiblePair(firstId: string, secondId: string) {
    const targets: PresenceTarget[] = [];
    for (const connection of connections) {
      if (connection.userId === firstId && connection.peerIds.has(secondId))
        targets.push({ connection, peerId: secondId });
      else if (
        connection.userId === secondId &&
        connection.peerIds.has(firstId)
      )
        targets.push({ connection, peerId: firstId });
    }
    await sendPresenceStatuses(targets, true);
  }

  async function persistLastSeen(userId: string): Promise<string> {
    const online = (perUser.get(userId)?.size ?? 0) > 0;
    if (online) lastSeenWrites.set(userId, Date.now());
    const result = await pool.query<{ last_seen_at: Date }>(
      `INSERT INTO presence(user_id,last_seen_at) VALUES($1,now())
       ON CONFLICT(user_id) DO UPDATE SET last_seen_at=now()
       RETURNING last_seen_at`,
      [userId],
    );
    if (!online) lastSeenWrites.delete(userId);
    return result.rows[0]!.last_seen_at.toISOString();
  }

  function remove(connection: Connection) {
    connections.delete(connection);
    connection.peerIds.clear();
    hub.unregister(connection.socket, connection.userId);
    const userSockets = perUser.get(connection.userId);
    userSockets?.delete(connection);
    if (userSockets?.size === 0) {
      perUser.delete(connection.userId);
      readWindows.delete(connection.userId);
      presenceWindows.delete(connection.userId);
      void persistLastSeen(connection.userId)
        .then(async () => {
          if ((perUser.get(connection!.userId)?.size ?? 0) === 0)
            await publishPresence(connection!.userId);
        })
        .catch((error: unknown) =>
          app.log.error(
            { errorType: error instanceof Error ? error.name : typeof error },
            "Presence update failed",
          ),
        );
    }
    const tokenSockets = perToken.get(connection.tokenHash);
    tokenSockets?.delete(connection);
    if (tokenSockets?.size === 0) perToken.delete(connection.tokenHash);
  }

  function closeToken(tokenHashValue: string) {
    for (const connection of perToken.get(tokenHashValue) ?? []) {
      connection.socket.close(4401, "session logged out");
      remove(connection);
    }
  }
  app.addHook("onClose", async () => {
    const userIds = [...perUser.keys()];
    for (const connection of connections) {
      connection.peerIds.clear();
      connection.socket.terminate();
    }
    connections.clear();
    perUser.clear();
    perToken.clear();
    lastSeenWrites.clear();
    await Promise.all(
      userIds.map((userId) =>
        persistLastSeen(userId).catch((error: unknown) => {
          app.log.error(
            { errorType: error instanceof Error ? error.name : typeof error },
            "Could not persist presence during shutdown",
          );
        }),
      ),
    );
  });

  await app.register(websocket, {
    options: { maxPayload, perMessageDeflate: false },
  });
  app.get(
    "/ws",
    {
      websocket: true,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      preValidation: async (request: FastifyRequest, reply: FastifyReply) => {
        const origin = request.headers.origin;
        if (origin && !options.origins.includes(origin)) {
          return reply.code(403).send({ error: "origin_forbidden" });
        }
      },
    },
    (socket) => {
      let connection: Connection | undefined;
      let authenticated = false;
      let closed = false;
      let lastWindow = Date.now();
      let frameCount = 0;
      let frameQueue: Promise<void> = Promise.resolve();

      const authTimer = setTimeout(() => {
        if (!authenticated && !closed) {
          closed = true;
          socket.close(4401, "authentication required");
        }
      }, options.authTimeoutMs ?? 5000);
      authTimer.unref();

      socket.on("pong", () => {
        if (connection) connection.alive = true;
      });
      socket.on("close", () => {
        closed = true;
        clearTimeout(authTimer);
        if (connection) remove(connection);
      });
      socket.on("error", () => {
        closed = true;
      });

      async function processFrame(
        data: WebSocket.RawData,
        isBinary: boolean,
      ): Promise<void> {
        if (closed || socket.readyState !== WebSocket.OPEN) return;

        const now = Date.now();
        if (now - lastWindow >= 10_000) {
          lastWindow = now;
          frameCount = 0;
        }
        frameCount += 1;
        if (frameCount > 120) {
          closed = true;
          socket.close(4429, "frame rate limit exceeded");
          return;
        }

        if (isBinary) {
          if (authenticated) errorFrame(socket, "invalid_frame");
          else {
            closed = true;
            socket.close(4401, "authentication required");
          }
          return;
        }

        let frame: unknown;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          if (authenticated) errorFrame(socket, "invalid_frame");
          else {
            closed = true;
            socket.close(4401, "authentication required");
          }
          return;
        }
        const frameClientMsgId = clientMsgIdFromFrame(frame);

        try {
          if (!authenticated) {
            if (
              !frame ||
              typeof frame !== "object" ||
              (frame as { type?: string }).type !== "auth" ||
              typeof (frame as { token?: unknown }).token !== "string" ||
              !tokenPattern.test((frame as { token: string }).token)
            ) {
              closed = true;
              socket.close(4401, "authentication required");
              return;
            }
            const token = (frame as { token: string }).token;
            const hash = tokenHash(token);
            const result = await pool.query<{ user_id: string }>(
              "SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at > now()",
              [hash],
            );
            if (closed || socket.readyState !== WebSocket.OPEN) return;
            if (!result.rowCount) {
              closed = true;
              socket.close(4401, "invalid token");
              return;
            }
            const userId = result.rows[0].user_id;
            const userConnections =
              perUser.get(userId) ?? new Set<Connection>();
            if (userConnections.size >= maxConnections) {
              closed = true;
              socket.close(4401, "connection limit");
              return;
            }
            authenticated = true;
            clearTimeout(authTimer);
            connection = {
              socket,
              userId,
              tokenHash: hash,
              alive: true,
              peerIds: new Set(),
            };
            const wasOnline = userConnections.size > 0;
            connections.add(connection);
            hub.register(socket, userId);
            userConnections.add(connection);
            perUser.set(userId, userConnections);
            const tokenConnections =
              perToken.get(hash) ?? new Set<Connection>();
            tokenConnections.add(connection);
            perToken.set(hash, tokenConnections);
            if (!wasOnline) {
              await persistLastSeen(userId);
              try {
                await publishPresence(userId);
              } catch (error) {
                app.log.error(
                  {
                    errorType:
                      error instanceof Error ? error.name : typeof error,
                  },
                  "Presence update failed",
                );
              }
            }
            socket.send(JSON.stringify({ type: "auth_ok", userId }));
            await hub.sendMailbox(socket, userId);
            return;
          }

          if (
            !frame ||
            typeof frame !== "object" ||
            typeof (frame as { type?: unknown }).type !== "string"
          ) {
            errorFrame(socket, "invalid_frame");
            return;
          }

          const type = (frame as { type: string }).type;
          if (type === "presence_subscribe") {
            const parsed = presenceSubscribeSchema.safeParse(frame);
            if (!parsed.success) {
              errorFrame(socket, "invalid_frame");
              return;
            }
            const time = Date.now();
            const recent = (
              presenceWindows.get(connection!.userId) ?? []
            ).filter((at) => time - at < 60_000);
            if (recent.length >= 30) {
              presenceWindows.set(connection!.userId, recent);
              errorFrame(socket, "rate_limited");
              return;
            }
            recent.push(time);
            presenceWindows.set(connection!.userId, recent);
            connection!.peerIds = new Set(parsed.data.peerIds);
            await sendPresenceStatuses(
              parsed.data.peerIds.map((peerId) => ({
                connection: connection!,
                peerId,
              })),
            );
            return;
          }
          if (type === "read") {
            const parsed = readSchema.safeParse(frame);
            if (!parsed.success) {
              errorFrame(socket, "invalid_frame");
              return;
            }
            const time = Date.now();
            const recent = (readWindows.get(connection!.userId) ?? []).filter(
              (at) => time - at < 60_000,
            );
            if (recent.length >= 30) {
              readWindows.set(connection!.userId, recent);
              return;
            }
            recent.push(time);
            readWindows.set(connection!.userId, recent);
            const maximum = await pool.query<{ seq: string }>(
              `SELECT max(seq::bigint)::text AS seq FROM messages WHERE sender_id=$1 AND recipient_id=$2`,
              [parsed.data.peerId, connection!.userId],
            );
            if (!maximum.rows[0]?.seq) return;
            const clamped =
              BigInt(parsed.data.upToSeq) > BigInt(maximum.rows[0].seq)
                ? maximum.rows[0].seq
                : parsed.data.upToSeq;
            const updated = await pool.query<{ read_up_to_seq: string }>(
              `INSERT INTO read_markers(reader_id, peer_id, read_up_to_seq)
               VALUES($1,$2,$3::bigint)
               ON CONFLICT(reader_id, peer_id) DO UPDATE
                 SET read_up_to_seq=GREATEST(read_markers.read_up_to_seq, EXCLUDED.read_up_to_seq), updated_at=now()
                 WHERE read_markers.read_up_to_seq < EXCLUDED.read_up_to_seq
               RETURNING read_up_to_seq::text`,
              [connection!.userId, parsed.data.peerId, clamped],
            );
            if (updated.rowCount)
              hub.sendToUser(parsed.data.peerId, {
                type: "read",
                from: connection!.userId,
                upToSeq: updated.rows[0]!.read_up_to_seq,
                readAt: new Date(time).toISOString(),
              });
            return;
          }
          if (type === "send") {
            const parsed = sendSchema.safeParse(frame);
            const clientMsgId = clientMsgIdFromFrame(frame);
            if (
              !parsed.success ||
              decodeBase64Size(parsed.data?.ciphertext ?? "") <= 0 ||
              decodeBase64Size(parsed.data?.ciphertext ?? "") > 64 * 1024 ||
              decodeBase64Size(parsed.data?.senderCopy ?? "") <= 0 ||
              decodeBase64Size(parsed.data?.senderCopy ?? "") > 64 * 1024
            ) {
              errorFrame(socket, "invalid_frame", clientMsgId);
              return;
            }
            const input = parsed.data;
            const recipient = await pool.query(
              "SELECT 1 FROM users WHERE id=$1",
              [input.to],
            );
            if (!recipient.rowCount) {
              errorFrame(socket, "recipient_not_found", input.clientMsgId);
              return;
            }
            const visibilityBefore = await getPresenceVisibility([
              { connection: connection!, peerId: input.to },
            ]);
            const wasVisible =
              visibilityBefore.get(`${connection!.userId}:${input.to}`) ??
              false;

            const inserted = await pool.query<MessageRow>(
              `INSERT INTO messages(sender_id, recipient_id, client_msg_id, ciphertext, sender_copy)
               VALUES($1,$2,$3,$4,$5)
               ON CONFLICT(sender_id, client_msg_id) DO NOTHING
               RETURNING id, seq::text AS seq, sender_id, recipient_id, client_msg_id, ciphertext, sender_copy, created_at, delivered_at`,
              [
                connection!.userId,
                input.to,
                input.clientMsgId,
                input.ciphertext,
                input.senderCopy,
              ],
            );
            const isNew = inserted.rows.length > 0;
            let row = inserted.rows[0];
            if (!row) {
              const existing = await pool.query<MessageRow>(
                `SELECT id, sender_id, recipient_id, client_msg_id, ciphertext,
                        sender_copy, created_at, delivered_at, seq::text AS seq
                 FROM messages WHERE sender_id=$1 AND client_msg_id=$2`,
                [connection!.userId, input.clientMsgId],
              );
              row = existing.rows[0];
              if (!row)
                throw new Error("Conflicting message row was not found");
            }
            if (row.recipient_id !== input.to) {
              errorFrame(socket, "client_msg_id_conflict", input.clientMsgId);
              return;
            }

            const createdAt = row.created_at.toISOString();
            hub.sendToUser(connection!.userId, {
              type: "sent",
              clientMsgId: row.client_msg_id,
              id: row.id,
              createdAt,
              seq: row.seq,
            });
            if (isNew) {
              const clear = await pool.query<{ clearedBeforeSeq: string }>(
                `SELECT COALESCE(
                   (SELECT cleared_before_seq::text FROM conversation_clears
                    WHERE user_id=$1 AND peer_id=$2),
                   '0'
                 ) AS "clearedBeforeSeq"`,
                [row.recipient_id, row.sender_id],
              );
              if (BigInt(row.seq) > BigInt(clear.rows[0]!.clearedBeforeSeq)) {
                hub.sendToUser(row.recipient_id, {
                  type: "message",
                  id: row.id,
                  from: row.sender_id,
                  ciphertext: row.ciphertext,
                  createdAt,
                  seq: row.seq,
                });
              }
              if (!wasVisible)
                await notifyNewlyVisiblePair(row.sender_id, row.recipient_id);
            }
            return;
          }

          if (type === "ack") {
            const parsed = ackSchema.safeParse(frame);
            if (!parsed.success) {
              errorFrame(socket, "invalid_frame");
              return;
            }
            const ids = parsed.data.ids;
            if (!ids.length) return;
            const acknowledged = await pool.query<MessageRow>(
              `UPDATE messages SET delivered_at=now()
               WHERE recipient_id=$1 AND id=ANY($2::uuid[]) AND delivered_at IS NULL
               RETURNING id, sender_id, recipient_id, client_msg_id, ciphertext, sender_copy, created_at, delivered_at`,
              [connection!.userId, ids],
            );
            for (const row of acknowledged.rows) {
              hub.sendToUser(row.sender_id, {
                type: "delivered",
                id: row.id,
                clientMsgId: row.client_msg_id,
                at: row.delivered_at!.toISOString(),
              });
            }
            await hub.acknowledge(socket, ids, connection!.userId);
            return;
          }

          errorFrame(socket, "invalid_frame");
        } catch (error) {
          const errorType = error instanceof Error ? error.name : typeof error;
          const errorMessage =
            error instanceof Error ? error.message : "Unknown frame error";
          app.log.error(
            { event: "ws_frame_error", errorType, errorMessage },
            "WebSocket frame processing failed",
          );
          errorFrame(socket, "internal_error", frameClientMsgId);
        }
      }

      socket.on("message", (data, isBinary) => {
        frameQueue = frameQueue
          .then(() => processFrame(data, isBinary))
          .catch((error: unknown) => {
            const errorType =
              error instanceof Error ? error.name : typeof error;
            const errorMessage =
              error instanceof Error ? error.message : "Unknown frame error";
            app.log.error(
              { event: "ws_frame_error", errorType, errorMessage },
              "WebSocket frame processing failed",
            );
            errorFrame(
              socket,
              "internal_error",
              clientMsgIdFromData(data, isBinary),
            );
          });
      });
    },
  );

  const heartbeat = setInterval(() => {
    for (const connection of connections) {
      if (!connection.alive) {
        connection.socket.terminate();
        remove(connection);
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
    const current = Date.now();
    for (const [userId, userSockets] of perUser) {
      if (
        userSockets.size &&
        current - (lastSeenWrites.get(userId) ?? 0) >= 60_000
      ) {
        void persistLastSeen(userId).catch((error: unknown) =>
          app.log.error(
            { errorType: error instanceof Error ? error.name : typeof error },
            "Presence heartbeat update failed",
          ),
        );
      }
    }
  }, 30_000);
  heartbeat.unref();
  app.addHook("onClose", async () => clearInterval(heartbeat));
  (
    app as FastifyInstance & { closeWsToken?: (hash: string) => void }
  ).closeWsToken = closeToken;
  return hub;
}

export function getWebSocketMemoryState(app: FastifyInstance) {
  if (process.env.NODE_ENV !== "test")
    throw new Error("WebSocket memory state is available in tests only");
  return (
    (
      app as FastifyInstance & {
        getWebSocketMemoryState?: () => {
          users: number;
          readWindows: number;
          subscribedConnections: number;
        };
      }
    ).getWebSocketMemoryState?.() ?? {
      users: 0,
      readWindows: 0,
      subscribedConnections: 0,
    }
  );
}

export function closeWebSocketsForToken(app: FastifyInstance, hash: string) {
  (
    app as FastifyInstance & { closeWsToken?: (hash: string) => void }
  ).closeWsToken?.(hash);
}
