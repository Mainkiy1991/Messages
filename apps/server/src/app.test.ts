import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  bytesToHex,
  decryptHistoryEntry,
  decryptTextMessage,
  deriveKeys,
  encryptHistoryEntry,
  encryptTextMessage,
  signAuth,
  signKeyBinding,
  generateMnemonic,
} from "@messages/crypto";
import { buildApp } from "./app.js";
import { getWebSocketMemoryState } from "./ws.js";

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
  let accountIp = 1;

  beforeAll(async () => {
    await pool!.query(
      "DROP TABLE IF EXISTS presence, read_markers, contact_books, messages, sessions, users, schema_migrations CASCADE",
    );
    await pool!.query(
      await readFile(
        join(import.meta.dirname, "..", "migrations", "001_initial.sql"),
        "utf8",
      ),
    );
    await pool!.query(
      await readFile(
        join(import.meta.dirname, "..", "migrations", "002_messages.sql"),
        "utf8",
      ),
    );
    await pool!.query(
      await readFile(
        join(
          import.meta.dirname,
          "..",
          "migrations",
          "003_message_sequence.sql",
        ),
        "utf8",
      ),
    );
    await pool!.query(
      await readFile(
        join(
          import.meta.dirname,
          "..",
          "migrations",
          "004_history_contacts.sql",
        ),
        "utf8",
      ),
    );
    await pool!.query(
      await readFile(
        join(import.meta.dirname, "..", "migrations", "005_read_markers.sql"),
        "utf8",
      ),
    );
    await pool!.query(
      await readFile(
        join(import.meta.dirname, "..", "migrations", "006_presence.sql"),
        "utf8",
      ),
    );
    app = await buildApp({
      databaseUrl: databaseUrl!,
      now: () => clock,
      trustProxy: true,
    });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  async function createChallenge(target = app, forwardedFor?: string) {
    const response = await target.inject({
      method: "POST",
      url: "/auth/challenge",
      ...(forwardedFor ? { headers: { "x-forwarded-for": forwardedFor } } : {}),
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

  async function createAccount() {
    const accountKeys = deriveKeys(generateMnemonic(12));
    const accountId = bytesToHex(accountKeys.identity.publicKey);
    const accountEncryption = bytesToHex(accountKeys.encryption.publicKey);
    const forwardedFor = `198.51.100.${accountIp++}`;
    const challenge = await createChallenge(app, forwardedFor);
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "x-forwarded-for": forwardedFor },
      payload: {
        challengeId: challenge.challengeId,
        identityPublicKey: accountId,
        encryptionPublicKey: accountEncryption,
        keyBindingSignature: bytesToHex(
          signKeyBinding(
            accountKeys.identity.privateKey,
            accountKeys.encryption.publicKey,
          ),
        ),
        signature: bytesToHex(
          signAuth(
            accountKeys.identity.privateKey,
            challenge.challengeId,
            challenge.challenge,
          ),
        ),
      },
    });
    expect(response.statusCode).toBe(200);
    return {
      userId: accountId,
      token: response.json().token as string,
      keys: accountKeys,
    };
  }

  async function listen() {
    if (!app.server.listening) await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP address");
    return `ws://127.0.0.1:${address.port}/ws`;
  }

  let websocketIp = 1;

  function connect(
    url: string,
    options: { origin?: string; forwardedFor?: string } = {},
  ) {
    const forwardedFor = options.forwardedFor ?? `192.0.2.${websocketIp++}`;
    const socket = new WebSocket(url, {
      headers: {
        origin: options.origin ?? "http://localhost:5173",
        "x-forwarded-for": forwardedFor,
      },
    });
    frameBuffers.set(socket, []);
    socket.on("message", (data) => {
      try {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        const waiters = frameWaiters.get(socket) ?? [];
        const index = waiters.findIndex((waiter) => waiter.predicate(frame));
        if (index >= 0) {
          const [waiter] = waiters.splice(index, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        } else {
          frameBuffers.get(socket)?.push(frame);
        }
      } catch {
        // Invalid JSON is tested through a direct frame listener.
      }
    });
    return socket;
  }

  const frameBuffers = new WeakMap<WebSocket, Record<string, unknown>[]>();
  const frameWaiters = new WeakMap<
    WebSocket,
    Array<{
      predicate: (frame: Record<string, unknown>) => boolean;
      resolve: (frame: Record<string, unknown>) => void;
      timer: ReturnType<typeof setTimeout>;
    }>
  >();

  function nextFrame(
    socket: WebSocket,
    predicate: (frame: Record<string, unknown>) => boolean,
  ) {
    const buffered = frameBuffers.get(socket) ?? [];
    const bufferedIndex = buffered.findIndex(predicate);
    if (bufferedIndex >= 0) {
      return Promise.resolve(buffered.splice(bufferedIndex, 1)[0]);
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = frameWaiters.get(socket) ?? [];
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("Timed out waiting for WebSocket frame"));
      }, 5000);
      const waiters = frameWaiters.get(socket) ?? [];
      waiters.push({ predicate, resolve, timer });
      frameWaiters.set(socket, waiters);
    });
  }

  async function connectAuth(token: string, url: string) {
    const socket = connect(url, { origin: "http://localhost:5173" });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const authFrame = nextFrame(socket, (frame) => frame.type === "auth_ok");
    socket.send(JSON.stringify({ type: "auth", token }));
    return { socket, auth: await authFrame };
  }

  function sendFrame(socket: WebSocket, frame: Record<string, unknown>) {
    socket.send(JSON.stringify(frame));
  }

  function payload(to: string, clientMsgId = randomId()) {
    return {
      type: "send",
      clientMsgId,
      to,
      ciphertext: Buffer.from("cipher").toString("base64"),
      senderCopy: Buffer.from("copy").toString("base64"),
    };
  }

  function randomId() {
    return randomBytes(16).toString("hex");
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

  it("accepts a valid first-frame WebSocket authentication", async () => {
    const account = await createAccount();
    const { socket, auth } = await connectAuth(account.token, await listen());
    expect(auth).toEqual({ type: "auth_ok", userId: account.userId });
    socket.close();
  });

  it("applies migration 006 on a clean schema and after 005 without losing rows", async () => {
    const migrationFiles = [
      "001_initial.sql",
      "002_messages.sql",
      "003_message_sequence.sql",
      "004_history_contacts.sql",
      "005_read_markers.sql",
      "006_presence.sql",
    ];
    async function applyInSchema(schema: string, count: number) {
      const client = await pool!.connect();
      try {
        await client.query(`CREATE SCHEMA ${schema}`);
        await client.query(`SET search_path TO ${schema}`);
        for (const name of migrationFiles.slice(0, count)) {
          const sql = await readFile(
            join(import.meta.dirname, "..", "migrations", name),
            "utf8",
          );
          await client.query(sql);
        }
        const columns = await client.query<{
          column_name: string;
          is_nullable: string;
        }>(
          `SELECT column_name, is_nullable FROM information_schema.columns
           WHERE table_schema=$1 AND table_name='presence' ORDER BY ordinal_position`,
          [schema],
        );
        expect(columns.rows).toEqual([
          { column_name: "user_id", is_nullable: "NO" },
          { column_name: "last_seen_at", is_nullable: "NO" },
        ]);
      } finally {
        await client.query("SET search_path TO public");
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        client.release();
      }
    }

    await applyInSchema(`presence_clean_${randomBytes(5).toString("hex")}`, 6);

    const schema = `presence_upgrade_${randomBytes(5).toString("hex")}`;
    const client = await pool!.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      for (const name of migrationFiles.slice(0, 5)) {
        await client.query(
          await readFile(
            join(import.meta.dirname, "..", "migrations", name),
            "utf8",
          ),
        );
      }
      await client.query(
        `INSERT INTO users(id,encryption_public_key,key_binding_signature)
         VALUES($1,$1,$1)`,
        ["ab".repeat(32)],
      );
      await client.query(
        `INSERT INTO messages(sender_id,recipient_id,client_msg_id,ciphertext,sender_copy)
         VALUES($1,$1,$2,'YQ==','YQ==')`,
        ["ab".repeat(32), randomId()],
      );
      await client.query(
        await readFile(
          join(import.meta.dirname, "..", "migrations", "006_presence.sql"),
          "utf8",
        ),
      );
      expect(
        (await client.query("SELECT count(*)::int AS count FROM messages"))
          .rows[0]?.count,
      ).toBe(1);
      expect(
        (await client.query("SELECT count(*)::int AS count FROM presence"))
          .rows[0]?.count,
      ).toBe(0);
    } finally {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
    }
  });

  it("tracks presence across multiple authenticated sockets and persists last seen", async () => {
    const a = await createAccount();
    const b = await createAccount();
    await pool!.query(
      `INSERT INTO messages(sender_id,recipient_id,client_msg_id,ciphertext,sender_copy)
       VALUES($1,$2,$3,'YQ==','YQ=='),($2,$1,$4,'Yg==','Yg==')`,
      [a.userId, b.userId, randomId(), randomId()],
    );
    const url = await listen();
    const viewer = (await connectAuth(a.token, url)).socket;
    const initial = nextFrame(viewer, (frame) => frame.type === "presence");
    sendFrame(viewer, { type: "presence_subscribe", peerIds: [b.userId] });
    expect((await initial).presences).toEqual([
      { peerId: b.userId, online: false, lastSeenAt: null },
    ]);

    const online = nextFrame(
      viewer,
      (frame) =>
        frame.type === "presence" &&
        Array.isArray(frame.presences) &&
        (frame.presences[0] as { online?: boolean } | undefined)?.online ===
          true,
    );
    const b1 = (await connectAuth(b.token, url)).socket;
    expect((await online).presences).toEqual([
      { peerId: b.userId, online: true, lastSeenAt: null },
    ]);
    const b2 = (await connectAuth(b.token, url)).socket;

    const b1Closed = new Promise<void>((resolve) =>
      b1.once("close", () => resolve()),
    );
    b1.close();
    await b1Closed;
    const stillOnline = nextFrame(viewer, (frame) => frame.type === "presence");
    sendFrame(viewer, { type: "presence_subscribe", peerIds: [b.userId] });
    expect((await stillOnline).presences).toEqual([
      { peerId: b.userId, online: true, lastSeenAt: null },
    ]);

    const offline = nextFrame(
      viewer,
      (frame) =>
        frame.type === "presence" &&
        Array.isArray(frame.presences) &&
        (frame.presences[0] as { peerId?: string } | undefined)?.peerId ===
          b.userId &&
        (frame.presences[0] as { online?: boolean } | undefined)?.online ===
          false,
    );
    const b2Closed = new Promise<void>((resolve) =>
      b2.once("close", () => resolve()),
    );
    b2.close();
    await b2Closed;
    const status = (await offline).presences as Array<{
      online: boolean;
      lastSeenAt: string | null;
    }>;
    expect(status[0]?.online).toBe(false);
    expect(status[0]?.lastSeenAt).toBeTruthy();
    viewer.close();
  });

  it("does not push presence changes when messages have flowed in only one direction", async () => {
    const a = await createAccount();
    const b = await createAccount();
    await pool!.query(
      "INSERT INTO messages(sender_id,recipient_id,client_msg_id,ciphertext,sender_copy) VALUES($1,$2,$3,'YQ==','YQ==')",
      [a.userId, b.userId, randomId()],
    );
    const url = await listen();
    const viewer = (await connectAuth(a.token, url)).socket;
    const snapshot = nextFrame(viewer, (frame) => frame.type === "presence");
    sendFrame(viewer, { type: "presence_subscribe", peerIds: [b.userId] });
    expect((await snapshot).presences).toEqual([
      { peerId: b.userId, online: false, lastSeenAt: null },
    ]);
    const target = (await connectAuth(b.token, url)).socket;
    expect(
      (frameBuffers.get(viewer) ?? []).filter(
        (frame) => frame.type === "presence",
      ),
    ).toEqual([]);
    expect(viewer.readyState).toBe(WebSocket.OPEN);
    target.close();
    viewer.close();
  });

  it("clears a closed socket's presence subscription without affecting another tab", async () => {
    const a = await createAccount();
    const b = await createAccount();
    await pool!.query(
      `INSERT INTO messages(sender_id,recipient_id,client_msg_id,ciphertext,sender_copy)
       VALUES($1,$2,$3,'YQ==','YQ=='),($2,$1,$4,'Yg==','Yg==')`,
      [a.userId, b.userId, randomId(), randomId()],
    );
    const url = await listen();
    const subscriber = (await connectAuth(a.token, url)).socket;
    const idleTab = (await connectAuth(a.token, url)).socket;
    const snapshot = nextFrame(
      subscriber,
      (frame) => frame.type === "presence",
    );
    const idleSnapshot = nextFrame(
      idleTab,
      (frame) => frame.type === "presence",
    );
    sendFrame(subscriber, { type: "presence_subscribe", peerIds: [b.userId] });
    sendFrame(idleTab, { type: "presence_subscribe", peerIds: [b.userId] });
    expect((await snapshot).presences).toEqual([
      { peerId: b.userId, online: false, lastSeenAt: null },
    ]);
    expect((await idleSnapshot).presences).toEqual([
      { peerId: b.userId, online: false, lastSeenAt: null },
    ]);

    const closed = new Promise<void>((resolve) =>
      subscriber.once("close", () => resolve()),
    );
    subscriber.close();
    await closed;
    const idleUpdate = nextFrame(
      idleTab,
      (frame) =>
        frame.type === "presence" &&
        (frame.presences as Array<{ online: boolean }>)[0]?.online === true,
    );
    const target = (await connectAuth(b.token, url)).socket;
    expect((await idleUpdate).presences).toEqual([
      { peerId: b.userId, online: true, lastSeenAt: null },
    ]);
    expect(idleTab.readyState).toBe(WebSocket.OPEN);
    target.close();
    idleTab.close();
  });

  it("clears read limits, user counts, and presence subscriptions after the last socket closes", async () => {
    const a = await createAccount();
    const b = await createAccount();
    const inserted = await pool!.query<{ seq: string }>(
      "INSERT INTO messages(sender_id,recipient_id,client_msg_id,ciphertext,sender_copy) VALUES($1,$2,$3,'YQ==','YQ==') RETURNING seq::text AS seq",
      [b.userId, a.userId, randomId()],
    );
    const url = await listen();
    const reader = (await connectAuth(a.token, url)).socket;
    const sender = (await connectAuth(b.token, url)).socket;
    const initial = nextFrame(reader, (frame) => frame.type === "presence");
    sendFrame(reader, { type: "presence_subscribe", peerIds: [b.userId] });
    await initial;
    const readUpdate = nextFrame(sender, (frame) => frame.type === "read");
    sendFrame(reader, {
      type: "read",
      peerId: b.userId,
      upToSeq: inserted.rows[0]!.seq,
    });
    await readUpdate;
    const readerClosed = new Promise<void>((resolve) =>
      reader.once("close", () => resolve()),
    );
    reader.close();
    await readerClosed;
    expect(getWebSocketMemoryState(app!)).toEqual({
      users: 1,
      readWindows: 0,
      subscribedConnections: 0,
    });
    const senderClosed = new Promise<void>((resolve) =>
      sender.once("close", () => resolve()),
    );
    sender.close();
    await senderClosed;
    expect(getWebSocketMemoryState(app!)).toEqual({
      users: 0,
      readWindows: 0,
      subscribedConnections: 0,
    });
  });

  it("accepts 500 presence keys and rejects 501 without closing the socket", async () => {
    const account = await createAccount();
    const socket = (await connectAuth(account.token, await listen())).socket;
    const maximum = nextFrame(socket, (frame) => frame.type === "presence");
    sendFrame(socket, {
      type: "presence_subscribe",
      peerIds: Array.from({ length: 500 }, () => "ab".repeat(32)),
    });
    expect(((await maximum).presences as unknown[]).length).toBe(500);

    const rejected = nextFrame(
      socket,
      (frame) => frame.type === "error" && frame.code === "invalid_frame",
    );
    sendFrame(socket, {
      type: "presence_subscribe",
      peerIds: Array.from({ length: 501 }, () => "ab".repeat(32)),
    });
    await rejected;
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it("serializes duplicate auth frames and removes closed connections from the limit", async () => {
    const account = await createAccount();
    const url = await listen();
    const sockets: WebSocket[] = [];
    for (let index = 0; index < 5; index++) {
      const socket = connect(url);
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const authOk = nextFrame(socket, (frame) => frame.type === "auth_ok");
      const duplicateAuthError = nextFrame(
        socket,
        (frame) => frame.type === "error" && frame.code === "invalid_frame",
      );
      const auth = JSON.stringify({ type: "auth", token: account.token });
      socket.send(auth);
      socket.send(auth);
      await authOk;
      await duplicateAuthError;
    }
    await Promise.all(
      sockets.map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once("close", () => resolve());
            socket.close();
          }),
      ),
    );
    const reopened = (await connectAuth(account.token, url)).socket;
    expect(reopened.readyState).toBe(WebSocket.OPEN);
    reopened.close();
  });

  it("closes WebSocket with 4401 for an invalid token", async () => {
    const socket = connect(await listen(), { origin: "http://localhost:5173" });
    await new Promise<void>((resolve) => socket.once("open", resolve));
    const closed = new Promise<number>((resolve) =>
      socket.once("close", (code) => resolve(code)),
    );
    socket.send(JSON.stringify({ type: "auth", token: "A".repeat(43) }));
    expect(await closed).toBe(4401);
  });

  it("closes unauthenticated WebSocket after configured timeout", async () => {
    const timeoutApp = await buildApp({
      databaseUrl: databaseUrl!,
      wsAuthTimeoutMs: 40,
    });
    try {
      const address = await timeoutApp.listen({ port: 0, host: "127.0.0.1" });
      const socket = connect(`${address.replace("http", "ws")}/ws`, {
        origin: "http://localhost:5173",
      });
      await new Promise<void>((resolve) => socket.once("open", resolve));
      const closed = new Promise<number>((resolve) =>
        socket.once("close", (code) => resolve(code)),
      );
      expect(await closed).toBe(4401);
    } finally {
      await timeoutApp.close();
    }
  });

  it("closes a WebSocket that sends a frame before auth", async () => {
    const socket = connect(await listen(), { origin: "http://localhost:5173" });
    await new Promise<void>((resolve) => socket.once("open", resolve));
    const closed = new Promise<number>((resolve) =>
      socket.once("close", (code) => resolve(code)),
    );
    socket.send(
      JSON.stringify({ type: "read", peerId: "ab".repeat(32), upToSeq: "1" }),
    );
    expect(await closed).toBe(4401);
  });

  it("rejects a WebSocket handshake with an unexpected Origin", async () => {
    const socket = connect(await listen(), { origin: "https://evil.example" });
    socket.on("error", () => {
      // The expected HTTP 403 prevents the WebSocket upgrade.
    });
    const failed = new Promise<number>((resolve) =>
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }),
    );
    expect(await failed).toBe(403);
    socket.terminate();
  });

  it("delivers an online message without senderCopy and confirms sent", async () => {
    const sender = await createAccount();
    const recipient = await createAccount();
    const url = await listen();
    const senderWs = (await connectAuth(sender.token, url)).socket;
    const recipientWs = (await connectAuth(recipient.token, url)).socket;
    const sent = nextFrame(senderWs, (frame) => frame.type === "sent");
    const message = nextFrame(recipientWs, (frame) => frame.type === "message");
    sendFrame(senderWs, payload(recipient.userId));
    const [sentFrame, messageFrame] = await Promise.all([sent, message]);
    expect(sentFrame.clientMsgId).toBeDefined();
    expect(messageFrame).not.toHaveProperty("senderCopy");
    expect(messageFrame.from).toBe(sender.userId);
    senderWs.close();
    recipientWs.close();
  });

  it("sends delivered to sender after recipient ack", async () => {
    const sender = await createAccount();
    const recipient = await createAccount();
    const url = await listen();
    const a = (await connectAuth(sender.token, url)).socket;
    const b = (await connectAuth(recipient.token, url)).socket;
    const sent = nextFrame(a, (f) => f.type === "sent");
    const message = nextFrame(b, (f) => f.type === "message");
    sendFrame(a, payload(recipient.userId));
    const [sentFrame, messageFrame] = await Promise.all([sent, message]);
    const delivered = nextFrame(a, (f) => f.type === "delivered");
    sendFrame(b, { type: "ack", ids: [messageFrame.id] });
    expect((await delivered).clientMsgId).toBe(sentFrame.clientMsgId);
    a.close();
    b.close();
  });

  it("delivers every online send and preserves sequential mailbox order", async () => {
    const sender = await createAccount();
    const onlineRecipient = await createAccount();
    const offlineRecipient = await createAccount();
    const url = await listen();
    const senderSocket = (await connectAuth(sender.token, url)).socket;
    const onlineSocket = (await connectAuth(onlineRecipient.token, url)).socket;
    const onlineOrder: string[] = [];
    const buffered = frameBuffers.get(onlineSocket) ?? [];
    for (const frame of buffered) {
      if (frame.type === "message" && typeof frame.ciphertext === "string")
        onlineOrder.push(frame.ciphertext);
    }
    frameBuffers.set(
      onlineSocket,
      buffered.filter((frame) => frame.type !== "message"),
    );
    const expectedOrder = Array.from({ length: 10 }, (_, index) =>
      Buffer.from([index + 1]).toString("base64"),
    );
    const onlineReceived = new Promise<void>((resolve) => {
      onlineSocket.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type !== "message") return;
        onlineOrder.push(frame.ciphertext);
        const received = new Set(onlineOrder);
        if (expectedOrder.every((ciphertext) => received.has(ciphertext)))
          resolve();
      });
    });
    const sendPromises = Array.from({ length: 10 }, (_, index) =>
      nextFrame(
        senderSocket,
        (frame) =>
          frame.type === "sent" &&
          frame.clientMsgId === index.toString(16).padStart(32, "0"),
      ),
    );
    for (let index = 0; index < 10; index++) {
      sendFrame(senderSocket, {
        ...payload(
          onlineRecipient.userId,
          index.toString(16).padStart(32, "0"),
        ),
        ciphertext: Buffer.from([index + 1]).toString("base64"),
      });
      sendFrame(senderSocket, {
        ...payload(
          offlineRecipient.userId,
          (index + 100).toString(16).padStart(32, "0"),
        ),
        ciphertext: Buffer.from([index + 1]).toString("base64"),
      });
    }
    await Promise.all(sendPromises);
    await onlineReceived;
    expect(new Set(onlineOrder)).toEqual(new Set(expectedOrder));

    const offlineSocket = connect(url);
    await new Promise<void>((resolve, reject) => {
      offlineSocket.once("open", resolve);
      offlineSocket.once("error", reject);
    });
    const authOk = nextFrame(
      offlineSocket,
      (frame) => frame.type === "auth_ok",
    );
    const mailboxMessages = Array.from({ length: 10 }, () =>
      nextFrame(offlineSocket, (frame) => frame.type === "message"),
    );
    offlineSocket.send(
      JSON.stringify({ type: "auth", token: offlineRecipient.token }),
    );
    await authOk;
    expect(
      new Set(
        (await Promise.all(mailboxMessages)).map((frame) => frame.ciphertext),
      ),
    ).toEqual(new Set(expectedOrder));
    senderSocket.close();
    onlineSocket.close();
    offlineSocket.close();
  });

  it("delivers offline messages from the mailbox after auth", async () => {
    const sender = await createAccount();
    const recipient = await createAccount();
    const url = await listen();
    const a = (await connectAuth(sender.token, url)).socket;
    const sent = nextFrame(a, (f) => f.type === "sent");
    sendFrame(a, payload(recipient.userId));
    await sent;
    const b = connect(url, { origin: "http://localhost:5173" });
    await new Promise<void>((resolve, reject) => {
      b.once("open", resolve);
      b.once("error", reject);
    });
    const auth = nextFrame(b, (f) => f.type === "auth_ok");
    const message = nextFrame(b, (f) => f.type === "message");
    b.send(JSON.stringify({ type: "auth", token: recipient.token }));
    await auth;
    expect((await message).from).toBe(sender.userId);
    a.close();
    b.close();
  });

  it("sends mailbox batches only after ack of the prior batch", async () => {
    const sender = await createAccount();
    const recipient = await createAccount();
    const batchApp = await buildApp({
      databaseUrl: databaseUrl!,
      wsBatchSize: 2,
    });
    try {
      const base = await batchApp.listen({ port: 0, host: "127.0.0.1" });
      const url = `${base.replace("http", "ws")}/ws`;
      for (let i = 0; i < 3; i++)
        await pool!.query(
          "INSERT INTO messages(sender_id,recipient_id,client_msg_id,ciphertext,sender_copy) VALUES($1,$2,$3,$4,$5)",
          [
            sender.userId,
            recipient.userId,
            `${i}`.padStart(32, "0"),
            "YQ==",
            "Yg==",
          ],
        );
      const b = connect(url, { origin: "http://localhost:5173" });
      await new Promise<void>((resolve) => b.once("open", resolve));
      const initial: string[] = [];
      const batchComplete = new Promise<void>((resolve) => {
        b.on("message", (data) => {
          const f = JSON.parse(data.toString());
          if (f.type === "message") {
            initial.push(f.id);
            if (initial.length === 2) resolve();
          }
        });
      });
      const authOk = nextFrame(b, (f) => f.type === "auth_ok");
      b.send(JSON.stringify({ type: "auth", token: recipient.token }));
      await authOk;
      await batchComplete;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(initial).toHaveLength(2);
      const third = nextFrame(b, (f) => f.type === "message");
      sendFrame(b, { type: "ack", ids: initial });
      expect(await third).toHaveProperty("type", "message");
      b.close();
    } finally {
      await batchApp.close();
    }
  });

  it("does not redeliver an already delivered message on repeated clientMsgId", async () => {
    const sender = await createAccount();
    const recipient = await createAccount();
    const url = await listen();
    const a = (await connectAuth(sender.token, url)).socket;
    const b = (await connectAuth(recipient.token, url)).socket;
    const id = randomId();
    let receivedMessages = 0;
    b.on("message", (data) => {
      if ((JSON.parse(data.toString()) as { type?: string }).type === "message")
        receivedMessages += 1;
    });
    const sent1 = nextFrame(a, (f) => f.type === "sent");
    const message = nextFrame(b, (f) => f.type === "message");
    sendFrame(a, payload(recipient.userId, id));
    const first = await sent1;
    const firstMessage = await message;
    const delivered = nextFrame(a, (f) => f.type === "delivered");
    sendFrame(b, { type: "ack", ids: [firstMessage.id] });
    await delivered;
    const sent2 = nextFrame(a, (f) => f.type === "sent");
    sendFrame(a, payload(recipient.userId, id));
    const second = await sent2;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(second.id).toBe(first.id);
    expect(receivedMessages).toBe(1);
    expect(
      (
        await pool!.query(
          "SELECT count(*)::int AS count FROM messages WHERE sender_id=$1 AND client_msg_id=$2",
          [sender.userId, id],
        )
      ).rows[0].count,
    ).toBe(1);
    a.close();
    b.close();
  });

  it("does not fetch a mailbox batch after acking a live message", async () => {
    const sender = await createAccount();
    const recipient = await createAccount();
    const url = await listen();
    const senderSocket = (await connectAuth(sender.token, url)).socket;
    const recipientSocket = (await connectAuth(recipient.token, url)).socket;
    const received: Record<string, unknown>[] = [];
    recipientSocket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame.type === "message") received.push(frame);
    });

    for (let index = 0; index < 2; index += 1) {
      const sent = nextFrame(senderSocket, (frame) => frame.type === "sent");
      sendFrame(senderSocket, payload(recipient.userId));
      await sent;
    }
    await vi.waitFor(() => expect(received).toHaveLength(2));
    sendFrame(recipientSocket, { type: "ack", ids: [received[0].id] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received.map((frame) => frame.id)).toHaveLength(2);
    expect(received.map((frame) => frame.id)).toEqual([
      expect.any(String),
      expect.any(String),
    ]);
    senderSocket.close();
    recipientSocket.close();
  });

  it("returns client_msg_id_conflict when a retry changes recipient", async () => {
    const sender = await createAccount();
    const firstRecipient = await createAccount();
    const secondRecipient = await createAccount();
    const url = await listen();
    const senderSocket = (await connectAuth(sender.token, url)).socket;
    const firstSocket = (await connectAuth(firstRecipient.token, url)).socket;
    const secondSocket = (await connectAuth(secondRecipient.token, url)).socket;
    const clientMsgId = randomId();
    const originalSent = nextFrame(
      senderSocket,
      (frame) => frame.type === "sent",
    );
    const originalMessage = nextFrame(
      firstSocket,
      (frame) => frame.type === "message",
    );
    sendFrame(senderSocket, payload(firstRecipient.userId, clientMsgId));
    await originalSent;
    await originalMessage;
    const conflict = nextFrame(senderSocket, (frame) => frame.type === "error");
    sendFrame(senderSocket, payload(secondRecipient.userId, clientMsgId));
    expect(await conflict).toMatchObject({
      code: "client_msg_id_conflict",
      clientMsgId,
    });
    senderSocket.close();
    firstSocket.close();
    secondSocket.close();
  });

  it("returns recipient_not_found for an unknown recipient", async () => {
    const sender = await createAccount();
    const a = (await connectAuth(sender.token, await listen())).socket;
    const error = nextFrame(a, (f) => f.type === "error");
    sendFrame(a, payload("f".repeat(64)));
    expect(await error).toMatchObject({ code: "recipient_not_found" });
    a.close();
  });

  it("rejects ciphertext larger than 64 KiB", async () => {
    const sender = await createAccount();
    const recipient = await createAccount();
    const a = (await connectAuth(sender.token, await listen())).socket;
    const error = nextFrame(a, (f) => f.type === "error");
    sendFrame(a, {
      ...payload(recipient.userId),
      ciphertext: Buffer.alloc(64 * 1024 + 1, 1).toString("base64"),
    });
    expect(await error).toMatchObject({ code: "invalid_frame" });
    a.close();
  });

  it("accepts ciphertext and senderCopy at exactly 64 KiB", async () => {
    const sender = await createAccount();
    const recipient = await createAccount();
    const url = await listen();
    const a = (await connectAuth(sender.token, url)).socket;
    const b = (await connectAuth(recipient.token, url)).socket;
    const maximumField = Buffer.alloc(64 * 1024, 7).toString("base64");
    const sent = nextFrame(a, (frame) => frame.type === "sent");
    const message = nextFrame(b, (frame) => frame.type === "message");
    sendFrame(a, {
      ...payload(recipient.userId),
      ciphertext: maximumField,
      senderCopy: maximumField,
    });
    await sent;
    expect((await message).ciphertext).toBe(maximumField);
    a.close();
    b.close();
  });

  it("returns internal_error with clientMsgId when frame processing hits a database error", async () => {
    const sender = await createAccount();
    const recipient = await createAccount();
    const a = (await connectAuth(sender.token, await listen())).socket;
    const clientMsgId = randomId();
    const ready = nextFrame(a, (frame) => frame.type === "presence");
    sendFrame(a, {
      type: "presence_subscribe",
      peerIds: [recipient.userId],
    });
    await ready;
    await pool!.query("ALTER TABLE messages RENAME TO messages_test_hold");
    try {
      const error = nextFrame(a, (frame) => frame.type === "error");
      sendFrame(a, payload(recipient.userId, clientMsgId));
      expect(await error).toMatchObject({
        code: "internal_error",
        clientMsgId,
      });
    } finally {
      await pool!.query("ALTER TABLE messages_test_hold RENAME TO messages");
      a.close();
    }
  });

  it("reports malformed JSON and keeps the server healthy", async () => {
    const sender = await createAccount();
    const a = (await connectAuth(sender.token, await listen())).socket;
    const error = nextFrame(a, (f) => f.type === "error");
    a.send("{");
    expect(await error).toMatchObject({ code: "invalid_frame" });
    expect(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
    ).toBe(200);
    a.close();
  });

  it("does not mark another recipient's message delivered on ack", async () => {
    const sender = await createAccount();
    const recipient = await createAccount();
    const stranger = await createAccount();
    const url = await listen();
    const a = (await connectAuth(sender.token, url)).socket;
    const b = (await connectAuth(recipient.token, url)).socket;
    const c = (await connectAuth(stranger.token, url)).socket;
    const sent = nextFrame(a, (f) => f.type === "sent");
    const message = nextFrame(b, (f) => f.type === "message");
    sendFrame(a, payload(recipient.userId));
    await sent;
    const m = await message;
    sendFrame(c, { type: "ack", ids: [m.id] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      (
        await pool!.query("SELECT delivered_at FROM messages WHERE id=$1", [
          m.id,
        ])
      ).rows[0].delivered_at,
    ).toBeNull();
    a.close();
    b.close();
    c.close();
  });

  it("closes token WebSockets on logout", async () => {
    const account = await createAccount();
    const socket = (await connectAuth(account.token, await listen())).socket;
    const closed = new Promise<number>((resolve) =>
      socket.once("close", (code) => resolve(code)),
    );
    const response = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { authorization: `Bearer ${account.token}` },
    });
    expect(response.statusCode).toBe(204);
    expect(await closed).toBe(4401);
  });

  it("closes a connection after 120 frames in ten seconds", async () => {
    const sender = await createAccount();
    const a = connect(await listen());
    await new Promise<void>((resolve, reject) => {
      a.once("open", resolve);
      a.once("error", reject);
    });
    const invalidFrameErrors = new Promise<void>((resolve) => {
      let count = 0;
      a.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === "error" && frame.code === "invalid_frame") {
          count += 1;
          if (count === 119) resolve();
        }
      });
    });
    const auth = JSON.stringify({ type: "auth", token: sender.token });
    for (let index = 0; index < 120; index++) a.send(auth);
    await invalidFrameErrors;
    const closed = new Promise<number>((resolve) =>
      a.once("close", (code) => resolve(code)),
    );
    sendFrame(a, { type: "unknown" });
    expect(await closed).toBe(4429);
  });

  it("rate limits WebSocket handshakes to 30 per minute per IP", async () => {
    const url = await listen();
    const sharedIp = "203.0.113.30";
    for (let index = 0; index < 30; index++) {
      const socket = connect(url, { forwardedFor: sharedIp });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const closed = new Promise<void>((resolve) =>
        socket.once("close", () => resolve()),
      );
      socket.close();
      await closed;
    }
    const limited = connect(url, { forwardedFor: sharedIp });
    limited.on("error", () => {
      // The expected HTTP 429 prevents the WebSocket upgrade.
    });
    const status = new Promise<number>((resolve) =>
      limited.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }),
    );
    expect(await status).toBe(429);
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

  it("lists conversations and serves isolated paginated history", async () => {
    const a = await createAccount();
    const b = await createAccount();
    const c = await createAccount();
    const rows = await pool!.query(
      `INSERT INTO messages(sender_id,recipient_id,client_msg_id,ciphertext,sender_copy)
       VALUES($1,$2,$3,$4,$5),($2,$1,$6,$7,$8),($1,$2,$9,$10,$11) RETURNING seq::text AS seq`,
      [
        a.userId,
        b.userId,
        randomBytes(16).toString("hex"),
        "in-payload",
        "a-copy",
        randomBytes(16).toString("hex"),
        "out-payload",
        "b-copy",
        randomBytes(16).toString("hex"),
        "in2",
        "a-copy2",
      ],
    );
    const conversations = await app.inject({
      method: "GET",
      url: "/conversations",
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(conversations.json().conversations).toHaveLength(1);
    expect(conversations.json().conversations[0].peerId).toBe(b.userId);
    const history = await app.inject({
      method: "GET",
      url: `/history/${b.userId}?limit=2`,
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(history.json()).toMatchObject({
      hasMore: true,
      messages: [
        { seq: rows.rows[1].seq, direction: "in", payload: "out-payload" },
        { seq: rows.rows[2].seq, direction: "out", payload: "a-copy2" },
      ],
    });
    expect(JSON.stringify(history.json())).not.toContain("b-copy");
    const isolated = await app.inject({
      method: "GET",
      url: `/history/${a.userId}`,
      headers: { authorization: `Bearer ${c.token}` },
    });
    expect(isolated.json()).toEqual({
      messages: [],
      hasMore: false,
      peerReadUpToSeq: null,
    });
  });

  it("returns the newest history page first and paginates every message exactly once", async () => {
    const a = await createAccount();
    const b = await createAccount();
    await pool!.query(
      `INSERT INTO messages(sender_id,recipient_id,client_msg_id,ciphertext,sender_copy)
       SELECT CASE WHEN n % 2 = 0 THEN $1 ELSE $2 END,
              CASE WHEN n % 2 = 0 THEN $2 ELSE $1 END,
              md5(random()::text || n::text), 'cipher', 'copy'
       FROM generate_series(1,55) AS n`,
      [a.userId, b.userId],
    );
    const expected = await pool!.query<{ seq: string }>(
      `SELECT seq::text AS seq FROM messages
       WHERE (sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1)
       ORDER BY seq::bigint ASC`,
      [a.userId, b.userId],
    );

    const pages: string[][] = [];
    let before: string | undefined;
    let hasMore = true;
    while (hasMore) {
      const url = new URL(`/history/${b.userId}`, "http://localhost");
      url.searchParams.set("limit", "7");
      if (before) url.searchParams.set("before", before);
      const response = await app.inject({
        method: "GET",
        url: `${url.pathname}${url.search}`,
        headers: { authorization: `Bearer ${a.token}` },
      });
      expect(response.statusCode).toBe(200);
      const page = response.json() as {
        messages: Array<{ seq: string }>;
        hasMore: boolean;
      };
      expect(page.messages.length).toBeGreaterThan(0);
      pages.push(page.messages.map((message) => message.seq));
      before = page.messages[0]!.seq;
      hasMore = page.hasMore;
    }

    for (const page of pages) {
      expect(page).toEqual(
        page.slice().sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)),
      );
    }
    expect(pages.reverse().flat()).toEqual(expected.rows.map((row) => row.seq));
    const cursor = expected.rows[48]!.seq;
    const forward = await app.inject({
      method: "GET",
      url: `/history/${b.userId}?after=${cursor}&limit=7`,
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(forward.statusCode).toBe(200);
    expect(
      forward.json().messages.map((message: { seq: string }) => message.seq),
    ).toEqual(expected.rows.slice(49).map((row) => row.seq));
  });

  it("paginates numeric sequence boundaries and clamps read markers numerically", async () => {
    const sender = await createAccount();
    const reader = await createAccount();
    const insertMessages = async (count: number) => {
      await pool!.query(
        `INSERT INTO messages(sender_id,recipient_id,client_msg_id,ciphertext,sender_copy)
         SELECT $1,$2,md5(random()::text || n::text), 'cipher','copy'
         FROM generate_series(1,$3) AS n`,
        [sender.userId, reader.userId, count],
      );
    };
    const setSequence = async (value: number) => {
      await pool!.query(
        "SELECT setval(pg_get_serial_sequence('messages','seq'), $1, true)",
        [value],
      );
    };

    await setSequence(97);
    await insertMessages(4);
    await setSequence(230);
    await insertMessages(1);
    await setSequence(997);
    await insertMessages(4);

    const conversations = await app.inject({
      method: "GET",
      url: "/conversations",
      headers: { authorization: `Bearer ${sender.token}` },
    });
    expect(conversations.json().conversations).toMatchObject([
      { peerId: reader.userId, lastSeq: "1001" },
    ]);

    const pages: Array<{ seqs: string[]; hasMore: boolean }> = [];
    let before: string | undefined;
    let hasMore = true;
    while (hasMore) {
      const url = new URL(`/history/${reader.userId}`, "http://localhost");
      url.searchParams.set("limit", "4");
      if (before) url.searchParams.set("before", before);
      const response = await app.inject({
        method: "GET",
        url: `${url.pathname}${url.search}`,
        headers: { authorization: `Bearer ${sender.token}` },
      });
      expect(response.statusCode).toBe(200);
      const page = response.json() as {
        messages: Array<{ seq: string }>;
        hasMore: boolean;
      };
      expect(page.messages.length).toBeGreaterThan(0);
      pages.push({
        seqs: page.messages.map((message) => message.seq),
        hasMore: page.hasMore,
      });
      before = page.messages[0]!.seq;
      hasMore = page.hasMore;
    }
    expect(pages[0]?.seqs).toEqual(["998", "999", "1000", "1001"]);
    expect(
      pages
        .map((page) => page.seqs)
        .reverse()
        .flat(),
    ).toEqual(["98", "99", "100", "101", "231", "998", "999", "1000", "1001"]);

    const forwardPages: string[][] = [];
    let after = "0";
    let more = true;
    while (more) {
      const response = await app.inject({
        method: "GET",
        url: `/history/${reader.userId}?after=${after}&limit=4`,
        headers: { authorization: `Bearer ${sender.token}` },
      });
      expect(response.statusCode).toBe(200);
      const page = response.json() as {
        messages: Array<{ seq: string }>;
        hasMore: boolean;
      };
      expect(page.messages.length).toBeGreaterThan(0);
      const seqs = page.messages.map((message) => message.seq);
      expect(seqs).toEqual(
        seqs.slice().sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)),
      );
      forwardPages.push(seqs);
      after = seqs.at(-1)!;
      more = page.hasMore;
    }
    const forwardSeqs = forwardPages.flat();
    expect(forwardSeqs).toEqual([
      "98",
      "99",
      "100",
      "101",
      "231",
      "998",
      "999",
      "1000",
      "1001",
    ]);
    expect(new Set(forwardSeqs).size).toBe(forwardSeqs.length);
    expect(forwardPages[0]).toContain("99");
    expect(forwardPages[0]).toContain("100");
    expect(forwardPages[1]).toContain("999");
    expect(forwardPages[1]).toContain("1000");

    const websocketUrl = await listen();
    const { socket: senderSocket } = await connectAuth(
      sender.token,
      websocketUrl,
    );
    const { socket: readerSocket } = await connectAuth(
      reader.token,
      websocketUrl,
    );
    try {
      const mailboxFrames = await Promise.all(
        Array.from({ length: 9 }, () =>
          nextFrame(readerSocket, (frame) => frame.type === "message"),
        ),
      );
      expect(mailboxFrames.map((frame) => frame.seq)).toEqual([
        "98",
        "99",
        "100",
        "101",
        "231",
        "998",
        "999",
        "1000",
        "1001",
      ]);

      const forwarded = nextFrame(
        senderSocket,
        (frame) => frame.type === "read",
      );
      sendFrame(readerSocket, {
        type: "read",
        peerId: sender.userId,
        upToSeq: "9999",
      });
      expect((await forwarded).upToSeq).toBe("1001");

      const history = await app.inject({
        method: "GET",
        url: `/history/${reader.userId}?limit=4`,
        headers: { authorization: `Bearer ${sender.token}` },
      });
      expect(history.json().peerReadUpToSeq).toBe("1001");
    } finally {
      senderSocket.close();
      readerSocket.close();
    }
  });

  it("stores monotonic read markers, clamps to real messages, forwards them, and exposes history", async () => {
    const sender = await createAccount();
    const reader = await createAccount();
    const peer = await createAccount();
    const inserted = await pool!.query<{ seq: string }>(
      `INSERT INTO messages(sender_id,recipient_id,client_msg_id,ciphertext,sender_copy)
       VALUES($1,$2,$3,'cipher','copy'),($1,$2,$4,'cipher','copy') RETURNING seq::text AS seq`,
      [sender.userId, reader.userId, randomId(), randomId()],
    );
    const url = await listen();
    const { socket: senderSocket } = await connectAuth(sender.token, url);
    const { socket: readerSocket } = await connectAuth(reader.token, url);
    const largest = inserted.rows
      .map((row) => BigInt(row.seq))
      .reduce((a, b) => (a > b ? a : b))
      .toString();
    sendFrame(readerSocket, {
      type: "read",
      peerId: sender.userId,
      upToSeq: "9223372036854775807",
    });
    const forwarded = await nextFrame(
      senderSocket,
      (frame) => frame.type === "read",
    );
    expect(forwarded).toMatchObject({
      type: "read",
      from: reader.userId,
      upToSeq: largest,
    });
    sendFrame(readerSocket, {
      type: "read",
      peerId: sender.userId,
      upToSeq: "1",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      (frameBuffers.get(senderSocket) ?? []).filter(
        (frame) => frame.type === "read",
      ),
    ).toHaveLength(0);
    const stored = await pool!.query<{ read_up_to_seq: string }>(
      "SELECT read_up_to_seq::text FROM read_markers WHERE reader_id=$1 AND peer_id=$2",
      [reader.userId, sender.userId],
    );
    expect(stored.rows[0]?.read_up_to_seq).toBe(largest);
    const history = await app.inject({
      method: "GET",
      url: `/history/${reader.userId}`,
      headers: { authorization: `Bearer ${sender.token}` },
    });
    expect(history.json().peerReadUpToSeq).toBe(largest);
    sendFrame(readerSocket, {
      type: "read",
      peerId: peer.userId,
      upToSeq: "not-a-number",
    });
    expect(
      await nextFrame(readerSocket, (frame) => frame.type === "error"),
    ).toMatchObject({ code: "invalid_frame" });
    senderSocket.close();
    readerSocket.close();
  });

  it("clamps a read to the selected peer's messages and leaves another pair unchanged", async () => {
    const sender = await createAccount();
    const reader = await createAccount();
    const otherSender = await createAccount();
    const inserted = await pool!.query<{ sender_id: string; seq: string }>(
      `INSERT INTO messages(sender_id,recipient_id,client_msg_id,ciphertext,sender_copy)
       VALUES($1,$2,$3,'cipher','copy'),($4,$2,$5,'cipher','copy')
       RETURNING sender_id, seq::text AS seq`,
      [
        sender.userId,
        reader.userId,
        randomId(),
        otherSender.userId,
        randomId(),
      ],
    );
    const ownSeq = inserted.rows.find(
      (row) => row.sender_id === sender.userId,
    )!.seq;
    const otherSeq = inserted.rows.find(
      (row) => row.sender_id === otherSender.userId,
    )!.seq;
    const url = await listen();
    const { socket: senderSocket } = await connectAuth(sender.token, url);
    const { socket: readerSocket } = await connectAuth(reader.token, url);
    const forwarded = nextFrame(senderSocket, (frame) => frame.type === "read");
    sendFrame(readerSocket, {
      type: "read",
      peerId: sender.userId,
      upToSeq: otherSeq,
    });
    expect((await forwarded).upToSeq).toBe(ownSeq);
    const pairs = await pool!.query<{
      peer_id: string;
      read_up_to_seq: string;
    }>(
      `SELECT peer_id, read_up_to_seq::text FROM read_markers WHERE reader_id=$1`,
      [reader.userId],
    );
    expect(pairs.rows).toEqual([
      { peer_id: sender.userId, read_up_to_seq: ownSeq },
    ]);
    senderSocket.close();
    readerSocket.close();
  });

  it("rejects strict read frames without closing the authenticated socket", async () => {
    const sender = await createAccount();
    const reader = await createAccount();
    const inserted = await pool!.query<{ seq: string }>(
      `INSERT INTO messages(sender_id,recipient_id,client_msg_id,ciphertext,sender_copy)
       VALUES($1,$2,$3,'cipher','copy') RETURNING seq::text AS seq`,
      [sender.userId, reader.userId, randomId()],
    );
    const url = await listen();
    const { socket: senderSocket } = await connectAuth(sender.token, url);
    const { socket: readerSocket } = await connectAuth(reader.token, url);
    sendFrame(readerSocket, {
      type: "read",
      peerId: sender.userId,
      upToSeq: inserted.rows[0]!.seq,
      unexpected: true,
    });
    expect(
      await nextFrame(readerSocket, (frame) => frame.type === "error"),
    ).toMatchObject({ code: "invalid_frame" });
    const forwarded = nextFrame(senderSocket, (frame) => frame.type === "read");
    sendFrame(readerSocket, {
      type: "read",
      peerId: sender.userId,
      upToSeq: inserted.rows[0]!.seq,
    });
    expect((await forwarded).upToSeq).toBe(inserted.rows[0]!.seq);
    expect(readerSocket.readyState).toBe(WebSocket.OPEN);
    senderSocket.close();
    readerSocket.close();
  });

  it("silently ignores read frames after the per-user minute limit", async () => {
    const sender = await createAccount();
    const reader = await createAccount();
    const rows = await pool!.query<{ seq: string }>(
      `INSERT INTO messages(sender_id,recipient_id,client_msg_id,ciphertext,sender_copy)
       SELECT $1,$2,md5(random()::text), 'cipher','copy' FROM generate_series(1,31) RETURNING seq::text AS seq`,
      [sender.userId, reader.userId],
    );
    const url = await listen();
    const { socket: senderSocket } = await connectAuth(sender.token, url);
    const { socket: readerSocket } = await connectAuth(reader.token, url);
    const seqs = rows.rows
      .map((row) => BigInt(row.seq))
      .sort((a, b) => (a < b ? -1 : 1));
    for (let index = 0; index < 30; index++) {
      const seq = seqs[index]!.toString();
      const forwarded = nextFrame(
        senderSocket,
        (frame) => frame.type === "read",
      );
      sendFrame(readerSocket, {
        type: "read",
        peerId: sender.userId,
        upToSeq: seq,
      });
      expect((await forwarded).upToSeq).toBe(seq);
    }
    sendFrame(readerSocket, {
      type: "read",
      peerId: sender.userId,
      upToSeq: seqs[30]!.toString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stored = await pool!.query<{ read_up_to_seq: string }>(
      "SELECT read_up_to_seq::text FROM read_markers WHERE reader_id=$1 AND peer_id=$2",
      [reader.userId, sender.userId],
    );
    expect(stored.rows[0]?.read_up_to_seq).toBe(seqs[29]!.toString());
    expect(
      (frameBuffers.get(senderSocket) ?? []).filter(
        (frame) => frame.type === "read",
      ),
    ).toHaveLength(0);
    senderSocket.close();
    readerSocket.close();
  });

  it("ignores a valid read marker when there are no messages from that peer", async () => {
    const reader = await createAccount();
    const peer = await createAccount();
    const url = await listen();
    const { socket } = await connectAuth(reader.token, url);
    sendFrame(socket, {
      type: "read",
      peerId: peer.userId,
      upToSeq: "100",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const marker = await pool!.query(
      "SELECT 1 FROM read_markers WHERE reader_id=$1 AND peer_id=$2",
      [reader.userId, peer.userId],
    );
    expect(marker.rowCount).toBe(0);
    expect(
      (frameBuffers.get(socket) ?? []).some((frame) => frame.type === "error"),
    ).toBe(false);
    socket.close();
  });

  it("validates history route inputs and requires authentication", async () => {
    const id = "ab".repeat(32);
    for (const url of [
      `/history/nope`,
      `/history/${id}?before=x`,
      `/history/${id}?limit=101`,
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${"x".repeat(43)}` },
      });
      expect(response.statusCode).toBe(401);
    }
    for (const url of [
      `/history/nope`,
      `/history/${id}?before=x`,
      `/history/${id}?limit=101`,
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${(await createAccount()).token}` },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(
      (await app.inject({ method: "GET", url: `/history/${id}?x=1` }))
        .statusCode,
    ).toBe(401);
  });

  it("allows the contacts PUT preflight only from the configured web origin", async () => {
    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/contacts",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5173",
    );
    expect(allowed.headers["access-control-allow-methods"]).toContain("PUT");
    const allowedHeaders = String(
      allowed.headers["access-control-allow-headers"],
    )
      .toLowerCase()
      .split(/,\s*/u);
    expect(allowedHeaders).toContain("authorization");
    expect(allowedHeaders).toContain("content-type");

    const denied = await app.inject({
      method: "OPTIONS",
      url: "/contacts",
      headers: {
        origin: "http://evil.example",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    expect(denied.headers["access-control-allow-methods"]).toBeUndefined();
    expect(denied.headers["access-control-allow-headers"]).toBeUndefined();
  });

  it("stores contacts with optimistic locking, atomic conflicts, and user isolation", async () => {
    const a = await createAccount();
    const b = await createAccount();
    const headers = { authorization: `Bearer ${a.token}` };
    expect(
      (await app.inject({ method: "GET", url: "/contacts", headers })).json(),
    ).toEqual({ version: "0", blob: null });
    const put = (baseVersion: string, blob: string, token = a.token) =>
      app.inject({
        method: "PUT",
        url: "/contacts",
        headers: { authorization: `Bearer ${token}` },
        payload: { baseVersion, blob },
      });
    expect((await put("1", "YQ==")).statusCode).toBe(409);
    const concurrent = await Promise.all([put("0", "YQ=="), put("0", "Yg==")]);
    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    const winner = concurrent.find((response) => response.statusCode === 200)!;
    expect(winner.json()).toEqual({ version: "1" });
    expect((await put("0", "Yw==")).json().error).toBe("version_conflict");
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/contacts",
          headers: { authorization: `Bearer ${b.token}` },
        })
      ).json(),
    ).toEqual({ version: "0", blob: null });
    expect((await put("1", "%")).statusCode).toBe(400);
    expect(
      (await put("1", Buffer.alloc(256 * 1024 + 1).toString("base64")))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/contacts" })).statusCode,
    ).toBe(401);
  });

  it("serves WebSocket messages as decryptable sender history and recipient ciphertext", async () => {
    const sender = await createAccount();
    const recipient = await createAccount();
    const clientMsgId = randomId();
    const sentAt = 1_700_000_000_000;
    const text = "Сквозное сообщение 🚀";
    const ciphertext = encryptTextMessage({
      senderEncryptionPrivateKey: sender.keys.encryption.privateKey,
      recipientEncryptionPublicKey: recipient.keys.encryption.publicKey,
      senderId: sender.userId,
      recipientId: recipient.userId,
      text,
      sentAt,
    });
    const senderCopy = encryptHistoryEntry({
      historyKey: sender.keys.historyKey,
      clientMsgId,
      peerId: recipient.userId,
      text,
      sentAt,
    });
    const url = await listen();
    const socket = (await connectAuth(sender.token, url)).socket;
    const sent = nextFrame(socket, (frame) => frame.type === "sent");
    sendFrame(socket, {
      type: "send",
      clientMsgId,
      to: recipient.userId,
      ciphertext,
      senderCopy,
    });
    await sent;
    const out = await app.inject({
      method: "GET",
      url: `/history/${recipient.userId}`,
      headers: { authorization: `Bearer ${sender.token}` },
    });
    const incoming = await app.inject({
      method: "GET",
      url: `/history/${sender.userId}`,
      headers: { authorization: `Bearer ${recipient.token}` },
    });
    const senderMessage = out.json().messages[0] as {
      payload: string;
      clientMsgId: string;
    };
    const recipientMessage = incoming.json().messages[0] as { payload: string };
    expect(
      decryptHistoryEntry({
        historyKey: sender.keys.historyKey,
        clientMsgId: senderMessage.clientMsgId,
        peerId: recipient.userId,
        entry: senderMessage.payload,
      }),
    ).toEqual({ text, sentAt });
    expect(
      decryptTextMessage({
        recipientEncryptionPrivateKey: recipient.keys.encryption.privateKey,
        senderEncryptionPublicKey: sender.keys.encryption.publicKey,
        senderId: sender.userId,
        recipientId: recipient.userId,
        ciphertext: recipientMessage.payload,
      }),
    ).toEqual({ text, sentAt });
    socket.close();
  });
});
