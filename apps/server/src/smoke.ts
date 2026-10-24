import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import {
  bytesToHex,
  deriveKeys,
  generateMnemonic,
  signAuth,
  signKeyBinding,
} from "@messages/crypto";
import { loadServerEnv } from "./env.js";

await loadServerEnv();
const baseUrl = process.env.SMOKE_URL ?? "http://localhost:3000";
const wsUrl = new URL("/ws", baseUrl);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
let step = "temporary accounts";
const sockets: WebSocket[] = [];
const tokens: string[] = [];

function pass(name: string): void {
  console.log(`PASS ${name}`);
}

function fail(name: string): never {
  throw new Error(name);
}

async function createAccount() {
  const keys = deriveKeys(generateMnemonic(12));
  const identityPublicKey = bytesToHex(keys.identity.publicKey);
  const challengeResponse = await fetch(new URL("/auth/challenge", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!challengeResponse.ok) fail("challenge");
  const challenge = (await challengeResponse.json()) as {
    challengeId: string;
    challenge: string;
  };
  const loginResponse = await fetch(new URL("/auth/login", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      identityPublicKey,
      encryptionPublicKey: bytesToHex(keys.encryption.publicKey),
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
    }),
  });
  if (!loginResponse.ok) fail("login");
  const login = (await loginResponse.json()) as {
    userId: string;
    token: string;
  };
  tokens.push(login.token);
  return login;
}

function waitForFrame(
  socket: WebSocket,
  type: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(type)), 10_000);
    const listener = (data: WebSocket.RawData) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (frame.type !== type) return;
      clearTimeout(timer);
      socket.off("message", listener);
      resolve(frame);
    };
    socket.on("message", listener);
  });
}

async function connect(token: string, expectMailbox = false) {
  const socket = new WebSocket(wsUrl);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const mailbox = expectMailbox ? waitForFrame(socket, "message") : undefined;
  const auth = waitForFrame(socket, "auth_ok");
  socket.send(JSON.stringify({ type: "auth", token }));
  await auth;
  return { socket, mailbox };
}

try {
  const sender = await createAccount();
  const recipient = await createAccount();
  pass("created two temporary users");

  step = "sender WebSocket auth";
  const { socket: senderSocket } = await connect(sender.token);
  pass(step);

  step = "send offline ciphertext";
  const clientMsgId = randomBytes(16).toString("hex");
  const sentPromise = waitForFrame(senderSocket, "sent");
  senderSocket.send(
    JSON.stringify({
      type: "send",
      clientMsgId,
      to: recipient.userId,
      ciphertext: randomBytes(32).toString("base64"),
      senderCopy: randomBytes(32).toString("base64"),
    }),
  );
  const sent = await sentPromise;
  if (sent.clientMsgId !== clientMsgId) fail(step);
  pass(step);

  step = "recipient mailbox delivery";
  const { socket: recipientSocket, mailbox } = await connect(
    recipient.token,
    true,
  );
  const message = await mailbox!;
  if (message.from !== sender.userId || typeof message.id !== "string")
    fail(step);
  pass(step);

  step = "recipient ack";
  recipientSocket.send(JSON.stringify({ type: "ack", ids: [message.id] }));
  const delivered = await waitForFrame(senderSocket, "delivered");
  if (delivered.id !== message.id || delivered.clientMsgId !== clientMsgId)
    fail(step);
  pass(step);

  step = "history and contacts";
  const senderHeaders = { authorization: `Bearer ${sender.token}` };
  const senderHistoryResponse = await fetch(
    new URL(`/history/${recipient.userId}`, baseUrl),
    { headers: senderHeaders },
  );
  const recipientHistoryResponse = await fetch(
    new URL(`/history/${sender.userId}`, baseUrl),
    { headers: { authorization: `Bearer ${recipient.token}` } },
  );
  if (!senderHistoryResponse.ok || !recipientHistoryResponse.ok) fail(step);
  const senderHistory = (await senderHistoryResponse.json()) as {
    messages: Array<{
      clientMsgId: string;
      direction: string;
      payload: string;
    }>;
  };
  const recipientHistory = (await recipientHistoryResponse.json()) as {
    messages: Array<{
      clientMsgId: string;
      direction: string;
      payload: string;
    }>;
  };
  if (
    !senderHistory.messages.some(
      (entry) => entry.clientMsgId === clientMsgId && entry.direction === "out",
    ) ||
    !recipientHistory.messages.some(
      (entry) => entry.clientMsgId === clientMsgId && entry.direction === "in",
    )
  )
    fail(step);
  const empty = await fetch(new URL("/contacts", baseUrl), {
    headers: senderHeaders,
  });
  if (
    !empty.ok ||
    ((await empty.json()) as { version: string }).version !== "0"
  )
    fail(step);
  const saved = await fetch(new URL("/contacts", baseUrl), {
    method: "PUT",
    headers: { ...senderHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      baseVersion: "0",
      blob: randomBytes(32).toString("base64"),
    }),
  });
  if (
    !saved.ok ||
    ((await saved.json()) as { version: string }).version !== "1"
  )
    fail(step);
  pass(step);

  step = "logout temporary sessions";
  for (const token of tokens) {
    const response = await fetch(new URL("/auth/logout", baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status !== 204) fail(step);
  }
  pass(step);
} catch {
  console.error(`FAIL ${step}`);
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.terminate();
}
