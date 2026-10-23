import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import type { Pool } from "pg";
import WebSocket from "ws";
import { z } from "zod";
import { createMessageHub, type MessageRow } from "./messages.js";

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

type Connection = {
  socket: WebSocket;
  userId: string;
  tokenHash: string;
  alive: boolean;
};
type WsOptions = {
  origin: string;
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
): Promise<void> {
  const maxPayload = options.maxPayload ?? 256 * 1024;
  const batchSize = options.batchSize ?? 200;
  const maxConnections = options.maxConnectionsPerUser ?? 5;
  const hub = createMessageHub(pool, batchSize);
  const connections = new Set<Connection>();
  const perUser = new Map<string, Set<Connection>>();
  const perToken = new Map<string, Set<Connection>>();

  function remove(connection: Connection) {
    connections.delete(connection);
    hub.unregister(connection.socket, connection.userId);
    const userSockets = perUser.get(connection.userId);
    userSockets?.delete(connection);
    if (userSockets?.size === 0) perUser.delete(connection.userId);
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
    for (const connection of connections)
      connection.socket.close(1001, "server closing");
    connections.clear();
    perUser.clear();
    perToken.clear();
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
        if (origin && origin !== options.origin) {
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
            connection = { socket, userId, tokenHash: hash, alive: true };
            connections.add(connection);
            hub.register(socket, userId);
            userConnections.add(connection);
            perUser.set(userId, userConnections);
            const tokenConnections =
              perToken.get(hash) ?? new Set<Connection>();
            tokenConnections.add(connection);
            perToken.set(hash, tokenConnections);
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

            const inserted = await pool.query<MessageRow>(
              `INSERT INTO messages(sender_id, recipient_id, client_msg_id, ciphertext, sender_copy)
               VALUES($1,$2,$3,$4,$5)
               ON CONFLICT(sender_id, client_msg_id) DO NOTHING
               RETURNING id, sender_id, recipient_id, client_msg_id, ciphertext, sender_copy, created_at, delivered_at`,
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
                        sender_copy, created_at, delivered_at
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
            });
            if (isNew) {
              hub.sendToUser(row.recipient_id, {
                type: "message",
                id: row.id,
                from: row.sender_id,
                ciphertext: row.ciphertext,
                createdAt,
              });
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
          errorFrame(socket, "internal_error", clientMsgIdFromFrame(frame));
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
  }, 30_000);
  heartbeat.unref();
  app.addHook("onClose", async () => clearInterval(heartbeat));
  (
    app as FastifyInstance & { closeWsToken?: (hash: string) => void }
  ).closeWsToken = closeToken;
}

export function closeWebSocketsForToken(app: FastifyInstance, hash: string) {
  (
    app as FastifyInstance & { closeWsToken?: (hash: string) => void }
  ).closeWsToken?.(hash);
}
