import type { Pool } from "pg";
import type WebSocket from "ws";

export type MessageRow = {
  id: string;
  sender_id: string;
  recipient_id: string;
  client_msg_id: string;
  ciphertext: string;
  sender_copy: string;
  created_at: Date;
  delivered_at: Date | null;
};

export type MessageHub = {
  register(socket: WebSocket, userId: string): void;
  unregister(socket: WebSocket, userId: string): void;
  sendToUser(userId: string, frame: Record<string, unknown>): void;
  sendMailbox(socket: WebSocket, userId: string): Promise<void>;
  acknowledge(socket: WebSocket, ids: string[], userId: string): Promise<void>;
};

export function createMessageHub(pool: Pool, batchSize = 200): MessageHub {
  const active = new Map<string, Set<WebSocket>>();
  const pending = new WeakMap<WebSocket, string[]>();

  function send(socket: WebSocket, frame: Record<string, unknown>) {
    if (socket.readyState === 1) socket.send(JSON.stringify(frame));
  }

  async function nextBatch(socket: WebSocket, userId: string) {
    if (pending.has(socket)) return;
    const result = await pool.query<MessageRow>(
      `SELECT id, sender_id, recipient_id, client_msg_id, ciphertext,
              sender_copy, created_at, delivered_at
       FROM messages WHERE recipient_id=$1 AND delivered_at IS NULL
       ORDER BY seq ASC LIMIT $2`,
      [userId, batchSize],
    );
    if (result.rows.length === 0) return;
    const ids = result.rows.map((row) => row.id);
    pending.set(socket, ids);
    for (const row of result.rows) {
      send(socket, {
        type: "message",
        id: row.id,
        from: row.sender_id,
        ciphertext: row.ciphertext,
        createdAt: row.created_at.toISOString(),
      });
    }
  }

  return {
    register(socket, userId) {
      const sockets = active.get(userId) ?? new Set<WebSocket>();
      sockets.add(socket);
      active.set(userId, sockets);
    },
    unregister(socket, userId) {
      const sockets = active.get(userId);
      sockets?.delete(socket);
      if (sockets?.size === 0) active.delete(userId);
      pending.delete(socket);
    },
    sendToUser(userId, frame) {
      for (const socket of active.get(userId) ?? []) send(socket, frame);
    },
    async sendMailbox(socket, userId) {
      await nextBatch(socket, userId);
    },
    async acknowledge(socket, ids, userId) {
      const unacked = (pending.get(socket) ?? []).filter(
        (id) => !ids.includes(id),
      );
      if (unacked.length) pending.set(socket, unacked);
      else pending.delete(socket);
      await nextBatch(socket, userId);
    },
  };
}
