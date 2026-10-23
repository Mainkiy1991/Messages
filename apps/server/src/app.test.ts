import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bytesToHex,
  deriveKeys,
  signAuth,
  signKeyBinding,
  generateMnemonic,
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
        join(import.meta.dirname, "..", "migrations", "002_messages.sql"),
        "utf8",
      ),
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

  async function createAccount() {
    const accountKeys = deriveKeys(generateMnemonic(12));
    const accountId = bytesToHex(accountKeys.identity.publicKey);
    const accountEncryption = bytesToHex(accountKeys.encryption.publicKey);
    const challenge = await createChallenge();
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
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
    return { userId: accountId, token: response.json().token as string };
  }

  async function listen() {
    if (!app.server.listening) await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP address");
    return `ws://127.0.0.1:${address.port}/ws`;
  }

  function connect(url: string, options: { origin?: string } = {}) {
    const socket = new WebSocket(url, {
      headers: options.origin ? { origin: options.origin } : {},
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
    socket.send(JSON.stringify({ type: "send" }));
    expect(await closed).toBe(4401);
  });

  it("rejects a WebSocket handshake with an unexpected Origin", async () => {
    const socket = connect(await listen(), { origin: "https://evil.example" });
    const failed = new Promise<number>((resolve) =>
      socket.once("unexpected-response", (_request, response) =>
        resolve(response.statusCode ?? 0),
      ),
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

  it("does not create duplicate messages for repeated clientMsgId", async () => {
    const sender = await createAccount();
    const recipient = await createAccount();
    const a = (await connectAuth(sender.token, await listen())).socket;
    const id = randomId();
    const sent1 = nextFrame(a, (f) => f.type === "sent");
    sendFrame(a, payload(recipient.userId, id));
    const first = await sent1;
    const sent2 = nextFrame(a, (f) => f.type === "sent");
    sendFrame(a, payload(recipient.userId, id));
    const second = await sent2;
    expect(second.id).toBe(first.id);
    expect(
      (
        await pool!.query(
          "SELECT count(*)::int AS count FROM messages WHERE sender_id=$1 AND client_msg_id=$2",
          [sender.userId, id],
        )
      ).rows[0].count,
    ).toBe(1);
    a.close();
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

  it("rate limits more than 30 send frames in ten seconds", async () => {
    const sender = await createAccount();
    const recipient = await createAccount();
    const a = (await connectAuth(sender.token, await listen())).socket;
    const error = nextFrame(
      a,
      (f) => f.type === "error" && f.code === "rate_limited",
    );
    for (let index = 0; index < 31; index++)
      sendFrame(a, payload(recipient.userId));
    expect(await error).toMatchObject({ code: "rate_limited" });
    a.close();
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
