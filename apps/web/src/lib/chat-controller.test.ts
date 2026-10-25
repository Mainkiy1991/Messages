import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bytesToHex,
  decryptContactBook,
  deriveKeys,
  encryptContactBook,
  encryptHistoryEntry,
  encryptTextMessage,
  signKeyBinding,
} from "@messages/crypto";
import { ApiError, type ContactBookResponse, type UserKeys } from "./api.js";
import {
  ChatController,
  chatPreview,
  contactLabel,
  mergeMessages,
  type ChatControllerDependencies,
  type ChatMessage,
} from "./chat-controller.js";
import type { ServerSession } from "../session.js";

const alice = deriveKeys(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
const bob = deriveKeys(
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
);
const aliceId = bytesToHex(alice.identity.publicKey);
const bobId = bytesToHex(bob.identity.publicKey);
const future = () => new Date(Date.now() + 60_000).toISOString();
const session = (token: string): ServerSession => ({
  token,
  expiresAt: future(),
  userId: aliceId,
});
const userKeys = (keys: typeof alice): UserKeys => ({
  userId: bytesToHex(keys.identity.publicKey),
  encryptionPublicKey: bytesToHex(keys.encryption.publicKey),
  keyBindingSignature: bytesToHex(
    signKeyBinding(keys.identity.privateKey, keys.encryption.publicKey),
  ),
});

class TestSocket extends EventTarget {
  sent: string[] = [];
  failSend = false;
  send(frame: string) {
    if (this.failSend) throw new TypeError("Network unavailable");
    this.sent.push(frame);
  }
  close(code = 1000) {
    const event = new Event("close");
    Object.defineProperty(event, "code", { value: code });
    this.dispatchEvent(event);
  }
  open() {
    this.dispatchEvent(new Event("open"));
  }
  frame(value: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }
  decoded() {
    return this.sent.map(
      (frame) => JSON.parse(frame) as Record<string, unknown>,
    );
  }
}

async function waitFor(
  predicate: () => boolean,
  timeout = 1000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout)
      throw new Error("Timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function makeController(
  options: {
    userKeys?: (peerId: string, token: string) => Promise<UserKeys>;
    initialSession?: ServerSession | null;
    login?: () => Promise<ServerSession>;
    socketFactory?: (url: string) => TestSocket;
    sendTimeoutMs?: number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
    random?: () => number;
    logout?: (token: string) => Promise<void>;
    getConversations?: ChatControllerDependencies["getConversations"];
    getContacts?: ChatControllerDependencies["getContacts"];
    getHistory?: ChatControllerDependencies["getHistory"];
    isVisible?: () => boolean;
  } = {},
) {
  const sockets: TestSocket[] = [];
  const tokens: string[] = [];
  let loginCount = 0;
  const controller = new ChatController(
    alice,
    aliceId,
    options.initialSession ?? null,
    {
      login: async () => {
        loginCount++;
        return options.login ? options.login() : session(`token-${loginCount}`);
      },
      fetchPeerKeys: async (peerId, token) => {
        tokens.push(token);
        if (options.userKeys) return options.userKeys(peerId, token);
        if (peerId === bobId) return userKeys(bob);
        if (peerId === aliceId) return userKeys(alice);
        throw new ApiError(404, "not_found");
      },
      socketFactory: (url) => {
        const socket = options.socketFactory?.(url) ?? new TestSocket();
        sockets.push(socket);
        return socket;
      },
      sendTimeoutMs: options.sendTimeoutMs,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
      random: options.random,
      logout: options.logout,
      getConversations: options.getConversations,
      getContacts: options.getContacts,
      getHistory: options.getHistory,
      isVisible: options.isVisible,
    },
  );
  return { controller, sockets, tokens, getLoginCount: () => loginCount };
}

async function authenticate(socket: TestSocket) {
  socket.open();
  socket.frame({ type: "auth_ok", userId: aliceId });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ChatController", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("preserves sending → sent → delivered and never downgrades on late sent", async () => {
    const f = makeController({ initialSession: session("token-a") });
    f.controller.start();
    await waitFor(() => f.sockets.length === 1);
    await authenticate(f.sockets[0]!);
    await f.controller.openChat(bobId);
    await f.controller.sendText("hello");
    let message = f.controller.getSnapshot().chats[0]!.messages[0]!;
    expect(message.status).toBe("sending");
    const clientMsgId = message.clientMsgId!;
    f.sockets[0]!.frame({
      type: "sent",
      clientMsgId,
      id: "00000000-0000-4000-8000-000000000001",
      createdAt: new Date().toISOString(),
    });
    await waitFor(
      () => f.controller.getSnapshot().chats[0]!.messages[0]!.status === "sent",
    );
    f.sockets[0]!.frame({ type: "delivered", clientMsgId });
    await waitFor(
      () =>
        f.controller.getSnapshot().chats[0]!.messages[0]!.status ===
        "delivered",
    );
    f.sockets[0]!.frame({
      type: "sent",
      clientMsgId,
      id: "00000000-0000-4000-8000-000000000001",
      createdAt: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    message = f.controller.getSnapshot().chats[0]!.messages[0]!;
    expect(message.status).toBe("delivered");
    f.controller.stop();
  });

  it("shows error on timeout and retries the exact frame with the same clientMsgId", async () => {
    const f = makeController({
      initialSession: session("token-a"),
      sendTimeoutMs: 5,
    });
    f.controller.start();
    await waitFor(() => f.sockets.length === 1);
    await authenticate(f.sockets[0]!);
    await f.controller.openChat(bobId);
    await f.controller.sendText("retry me");
    const original = f.sockets[0]!.decoded().find(
      (frame) => frame.type === "send",
    )!;
    const clientMsgId = original.clientMsgId as string;
    await waitFor(
      () =>
        f.controller.getSnapshot().chats[0]!.messages[0]!.status === "error",
    );
    f.controller.retryMessage(bobId, clientMsgId);
    const sentFrames = f.sockets[0]!.decoded().filter(
      (frame) => frame.type === "send",
    );
    expect(sentFrames).toHaveLength(2);
    expect(sentFrames[1]).toEqual(original);
    expect(f.controller.getSnapshot().chats[0]!.messages[0]!.status).toBe(
      "sending",
    );
    f.controller.stop();
  });

  it("marks a correlated server error and Retry sends the same clientMsgId and ciphertext", async () => {
    const f = makeController({
      initialSession: session("token-a"),
      sendTimeoutMs: 10_000,
    });
    f.controller.start();
    await waitFor(() => f.sockets.length === 1);
    await authenticate(f.sockets[0]!);
    await f.controller.openChat(bobId);
    await f.controller.sendText("server rejected");
    const before = f.sockets[0]!.decoded().find(
      (frame) => frame.type === "send",
    )!;
    f.sockets[0]!.frame({
      type: "error",
      code: "recipient_not_found",
      clientMsgId: before.clientMsgId,
    });
    await waitFor(
      () =>
        f.controller.getSnapshot().chats[0]!.messages[0]!.status === "error",
    );
    expect(f.controller.getSnapshot().chats[0]!.messages[0]!.error).toBe(
      "user_not_found",
    );
    f.controller.retryMessage(bobId, String(before.clientMsgId));
    const after = f.sockets[0]!.decoded()
      .filter((frame) => frame.type === "send")
      .at(-1)!;
    expect(after).toEqual(before);
    f.controller.stop();
  });

  it("marks all outstanding sends failed on an error without clientMsgId", async () => {
    const f = makeController({
      initialSession: session("token-a"),
      sendTimeoutMs: 10_000,
    });
    f.controller.start();
    await waitFor(() => f.sockets.length === 1);
    await authenticate(f.sockets[0]!);
    await f.controller.openChat(bobId);
    await f.controller.sendText("first");
    await f.controller.sendText("second");
    f.sockets[0]!.frame({ type: "error", code: "rate_limited" });
    await waitFor(() =>
      f.controller
        .getSnapshot()
        .chats[0]!.messages.every((message) => message.status === "error"),
    );
    f.controller.stop();
  });

  it("renders only the failure placeholder and acks when decryption fails or the peer key is invalid", async () => {
    for (const fetchPeerKeys of [
      async () => {
        throw new ApiError(404, "not_found");
      },
      async () => ({ ...userKeys(bob), keyBindingSignature: "00".repeat(64) }),
      async () => userKeys(bob),
    ]) {
      const f = makeController({
        initialSession: session("token-a"),
        userKeys: fetchPeerKeys,
      });
      f.controller.start();
      await waitFor(() => f.sockets.length === 1);
      await authenticate(f.sockets[0]!);
      f.sockets[0]!.frame({
        type: "message",
        id: crypto.randomUUID(),
        from: bobId,
        ciphertext: "not-valid",
        createdAt: new Date().toISOString(),
      });
      await waitFor(() => f.controller.getSnapshot().chats.length === 1);
      await waitFor(() =>
        f.sockets[0]!.decoded().some((frame) => frame.type === "ack"),
      );
      expect(f.controller.getSnapshot().chats[0]!.messages[0]!.text).toBe("");
      expect(
        f.controller.getSnapshot().chats[0]!.messages[0]!.decryptFailed,
      ).toBe(true);
      expect(JSON.stringify(f.controller.getSnapshot())).not.toContain(
        "not-valid",
      );
      f.controller.stop();
    }
  });

  it("renders the legacy placeholder string as ordinary decrypted message text", async () => {
    const f = makeController({ initialSession: session("token-a") });
    f.controller.start();
    await waitFor(() => f.sockets.length === 1);
    await authenticate(f.sockets[0]!);
    f.sockets[0]!.frame({
      type: "message",
      id: crypto.randomUUID(),
      from: bobId,
      ciphertext: encryptTextMessage({
        senderEncryptionPrivateKey: bob.encryption.privateKey,
        recipientEncryptionPublicKey: alice.encryption.publicKey,
        senderId: bobId,
        recipientId: aliceId,
        text: "__DECRYPT_FAILED__",
        sentAt: Date.now(),
      }),
      createdAt: new Date().toISOString(),
    });
    await waitFor(() => f.controller.getSnapshot().chats.length === 1);
    const message = f.controller.getSnapshot().chats[0]!.messages[0]!;
    expect(message.text).toBe("__DECRYPT_FAILED__");
    expect(message.decryptFailed).toBeUndefined();
    f.controller.stop();
  });

  it("serializes 20 mailbox messages and shares one in-flight peer-key request", async () => {
    let release!: (value: UserKeys) => void;
    let requests = 0;
    const deferred = new Promise<UserKeys>((resolve) => {
      release = resolve;
    });
    const f = makeController({
      initialSession: session("token-a"),
      userKeys: async () => {
        requests++;
        return deferred;
      },
    });
    f.controller.start();
    await waitFor(() => f.sockets.length === 1);
    await authenticate(f.sockets[0]!);
    const frames = Array.from({ length: 20 }, (_, index) => ({
      type: "message",
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      from: bobId,
      ciphertext: encryptTextMessage({
        senderEncryptionPrivateKey: bob.encryption.privateKey,
        recipientEncryptionPublicKey: alice.encryption.publicKey,
        senderId: bobId,
        recipientId: aliceId,
        text: `mail-${index}`,
        sentAt: 1_700_000_000_000 + index,
      }),
      createdAt: new Date(1_700_000_000_000 + index).toISOString(),
    }));
    for (const frame of frames) f.sockets[0]!.frame(frame);
    await waitFor(() => requests === 1);
    expect(f.controller.getSnapshot().chats).toHaveLength(0);
    release(userKeys(bob));
    await waitFor(
      () => f.controller.getSnapshot().chats[0]?.messages.length === 20,
    );
    expect(
      f.controller
        .getSnapshot()
        .chats[0]!.messages.map((message) => message.text),
    ).toEqual(Array.from({ length: 20 }, (_, index) => `mail-${index}`));
    await waitFor(
      () =>
        f.sockets[0]!.decoded()
          .filter((frame) => frame.type === "ack")
          .reduce(
            (count, frame) => count + (frame.ids as string[]).length,
            0,
          ) === 20,
    );
    expect(
      f.sockets[0]!.decoded()
        .filter((frame) => frame.type === "ack")
        .flatMap((frame) => frame.ids as string[]),
    ).toEqual(frames.map((frame) => frame.id));
    expect(requests).toBe(1);
    f.controller.stop();
  });

  it("keeps the active chat and increments unread count for a different incoming peer", async () => {
    const charlie = deriveKeys(
      "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
    );
    const charlieId = bytesToHex(charlie.identity.publicKey);
    const f = makeController({
      initialSession: session("token-a"),
      userKeys: async (peerId) =>
        peerId === bobId ? userKeys(bob) : userKeys(charlie),
    });
    f.controller.start();
    await waitFor(() => f.sockets.length === 1);
    await authenticate(f.sockets[0]!);
    await f.controller.openChat(bobId);
    f.sockets[0]!.frame({
      type: "message",
      id: crypto.randomUUID(),
      from: charlieId,
      ciphertext: "bad",
      createdAt: new Date().toISOString(),
    });
    await waitFor(() =>
      f.controller
        .getSnapshot()
        .chats.some((chat) => chat.peerId === charlieId),
    );
    expect(f.controller.getSnapshot().activePeer).toBe(bobId);
    expect(
      f.controller.getSnapshot().chats.find((chat) => chat.peerId === charlieId)
        ?.unreadCount,
    ).toBe(1);
    f.controller.selectChat(charlieId);
    expect(
      f.controller.getSnapshot().chats.find((chat) => chat.peerId === charlieId)
        ?.unreadCount,
    ).toBe(0);
    f.controller.stop();
  });

  it("uses the refreshed token for peer-key requests and logout after a 4401 reconnect", async () => {
    const logoutTokens: string[] = [];
    const f = makeController({
      initialSession: session("old-token"),
      logout: async (token) => {
        logoutTokens.push(token);
      },
    });
    f.controller.start();
    await waitFor(() => f.sockets.length === 1);
    await authenticate(f.sockets[0]!);
    f.sockets[0]!.close(4401);
    await waitFor(() => f.sockets.length === 2);
    await authenticate(f.sockets[1]!);
    await f.controller.openChat(bobId);
    expect(f.tokens.at(-1)).toBe("token-1");
    await f.controller.logout();
    expect(logoutTokens).toEqual(["token-1"]);
  });

  it("relogs in once and retries a peer-key request after an API 401", async () => {
    const f = makeController({
      initialSession: session("expired-at-server"),
      userKeys: async (peerId, token) => {
        if (token === "expired-at-server")
          throw new ApiError(401, "unauthorized");
        expect(peerId).toBe(bobId);
        return userKeys(bob);
      },
    });
    await f.controller.openChat(bobId);
    expect(f.tokens).toEqual(["expired-at-server", "token-1"]);
    expect(f.controller.currentToken()).toBe("token-1");
    expect(f.controller.getSnapshot().activePeer).toBe(bobId);
    f.controller.stop();
  });

  it("separates missing users, bad peer keys, and unavailable key lookup", async () => {
    for (const [failure, expected] of [
      [new ApiError(404, "not_found"), "user_not_found"],
      [new Error("key_binding_invalid"), "bad_peer_key"],
      [new ApiError(0, "network_timeout"), "server_unavailable"],
    ] as const) {
      const f = makeController({
        initialSession: session("token-a"),
        userKeys: async () => {
          throw failure;
        },
      });
      await f.controller.openChat(bobId);
      expect(f.controller.getSnapshot().error).toBe(expected);
      expect(f.controller.getSnapshot().activePeer).toBe("");
      f.controller.stop();
    }
  });

  it("reports a synchronous socket send failure as unavailable and marks the message failed", async () => {
    const f = makeController({ initialSession: session("token-a") });
    f.controller.start();
    await waitFor(() => f.sockets.length === 1);
    await authenticate(f.sockets[0]!);
    await f.controller.openChat(bobId);
    f.sockets[0]!.failSend = true;
    await f.controller.sendText("fails on the socket");
    const state = f.controller.getSnapshot();
    expect(state.error).toBe("server_unavailable");
    expect(state.chats[0]!.messages[0]!.status).toBe("error");
    expect(state.chats[0]!.messages[0]!.error).toBe("send_failed");
    f.controller.stop();
  });

  it("retries logout once with a fresh token after a 401", async () => {
    const logoutTokens: string[] = [];
    const controller = new ChatController(alice, aliceId, session("expired"), {
      login: async () => session("fresh"),
      logout: async (token) => {
        logoutTokens.push(token);
        if (token === "expired") throw new ApiError(401, "unauthorized");
      },
    });
    await controller.logout();
    expect(logoutTokens).toEqual(["expired", "fresh"]);
  });

  it("merges history and live frames by id or clientMsgId without duplicates", () => {
    const base: ChatMessage = {
      id: "client",
      clientMsgId: "same",
      text: "pending",
      createdAt: "2025-01-01T00:00:00.000Z",
      direction: "out",
      status: "sending",
      arrivalOrder: 0,
    };
    const history: ChatMessage = {
      ...base,
      id: "server-id",
      text: "saved",
      seq: "4",
      status: undefined,
      arrivalOrder: 1,
    };
    const result = mergeMessages([base], [history]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "server-id",
      clientMsgId: "same",
      text: "saved",
      status: "sending",
    });
  });

  it("orders merged history and advances its cursor numerically across digit boundaries", async () => {
    const calls: Array<string | undefined> = [];
    const createEntry = (seq: string) => {
      const clientMsgId = seq.padStart(32, "0");
      return {
        id: `history-${seq}`,
        seq,
        direction: "out" as const,
        clientMsgId,
        payload: encryptHistoryEntry({
          historyKey: alice.historyKey,
          clientMsgId,
          peerId: bobId,
          text: `message ${seq}`,
          sentAt: Date.now(),
        }),
        createdAt: `2025-01-01T00:00:${seq.padStart(2, "0")}Z`,
        deliveredAt: null,
      };
    };
    const controller = new ChatController(alice, aliceId, session("token"), {
      fetchPeerKeys: async () => userKeys(bob),
      getHistory: async (_peerId, _token, before) => {
        calls.push(before);
        return before === undefined
          ? {
              hasMore: true,
              messages: ["231", "99", "101", "100"].map(createEntry),
            }
          : { hasMore: false, messages: ["98"].map(createEntry) };
      },
    });

    await controller.openChat(bobId);
    await waitFor(
      () => controller.getSnapshot().chats[0]?.messages.length === 4,
    );
    expect(
      controller.getSnapshot().chats[0]!.messages.map((message) => message.seq),
    ).toEqual(["99", "100", "101", "231"]);

    await controller.loadHistory(bobId);
    await waitFor(() => controller.getSnapshot().chats[0]?.hasMore === false);
    expect(calls).toEqual([undefined, "99"]);
    expect(
      controller.getSnapshot().chats[0]!.messages.map((message) => message.seq),
    ).toEqual(["98", "99", "100", "101", "231"]);
    controller.stop();
  });

  it("uses the final ten ID characters when a contact name is missing", () => {
    expect(contactLabel(bobId, {})).toBe(bobId.slice(-10));
    expect(contactLabel(bobId, { [bobId]: "Bob" })).toBe("Bob");
  });

  it("keeps conversations visible when contacts fail and uses ID labels", async () => {
    vi.stubGlobal("window", {});
    const controller = new ChatController(alice, aliceId, session("token"), {
      getConversations: async () => ({
        conversations: [
          { peerId: bobId, lastSeq: "2", lastCreatedAt: future() },
        ],
      }),
      getContacts: async () => {
        throw new ApiError(500, "internal_error");
      },
    });
    await (
      controller as unknown as { loadAccountData(): Promise<void> }
    ).loadAccountData();
    expect(controller.getSnapshot().chats.map((chat) => chat.peerId)).toEqual([
      bobId,
    ]);
    expect(controller.getSnapshot().contactsError).toBe(true);
    expect(contactLabel(bobId, controller.getSnapshot().contacts)).toBe(
      bobId.slice(-10),
    );
    controller.stop();
  });

  it("loads previews from history with at most three requests and twenty chats", async () => {
    vi.stubGlobal("window", {});
    const peers = Array.from({ length: 25 }, (_, index) =>
      index.toString(16).padStart(64, "0"),
    );
    let active = 0;
    let peak = 0;
    const calls: string[] = [];
    const controller = new ChatController(alice, aliceId, session("token"), {
      getConversations: async () => ({
        conversations: peers.map((peerId, index) => ({
          peerId,
          lastSeq: "1",
          lastCreatedAt: new Date(Date.now() - index * 1000).toISOString(),
        })),
      }),
      getContacts: async () => ({ version: "0", blob: null }),
      getHistory: async (peerId) => {
        calls.push(peerId);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        if (peerId === peers[0]) {
          const clientMsgId = "00000000000000000000000000000031";
          return {
            hasMore: false,
            messages: [
              {
                id: "preview",
                seq: "1",
                direction: "out",
                clientMsgId,
                payload: encryptHistoryEntry({
                  historyKey: alice.historyKey,
                  clientMsgId,
                  peerId,
                  text: "Latest preview",
                  sentAt: Date.now(),
                }),
                createdAt: new Date().toISOString(),
                deliveredAt: null,
              },
            ],
          };
        }
        return { messages: [], hasMore: false };
      },
    });
    await (
      controller as unknown as { loadAccountData(): Promise<void> }
    ).loadAccountData();
    await waitFor(() => calls.length === 20);
    expect(calls).toHaveLength(20);
    expect(peak).toBeLessThanOrEqual(3);
    expect(controller.getSnapshot().chats[0]?.messages[0]?.text).toBe(
      "Latest preview",
    );
    expect(controller.getSnapshot().error).toBe("");
    controller.stop();
  });

  it("keeps preview history failures quiet and only labels loaded empty chats", async () => {
    vi.stubGlobal("window", {});
    const controller = new ChatController(alice, aliceId, session("token"), {
      getConversations: async () => ({
        conversations: [
          { peerId: bobId, lastSeq: "1", lastCreatedAt: future() },
        ],
      }),
      getContacts: async () => ({ version: "0", blob: null }),
      outbox: {
        list: async () => [],
        put: async () => undefined,
        remove: async () => undefined,
        clear: async () => undefined,
      },
      getHistory: async () => {
        throw new ApiError(503, "unavailable");
      },
    });
    await (
      controller as unknown as { loadAccountData(): Promise<void> }
    ).loadAccountData();
    await controller.loadHistory(bobId, { silent: true });
    expect(controller.getSnapshot().error).toBe("");
    expect(
      chatPreview(controller.getSnapshot().chats[0]!, {
        loading: "Loading…",
        decryptFailed: "Could not decrypt",
        noMessages: "No messages",
        you: "You",
      }),
    ).toBe("");
    expect(
      chatPreview(
        {
          peerId: bobId,
          messages: [],
          unreadCount: 0,
          hasMore: true,
        },
        {
          loading: "Loading…",
          decryptFailed: "Could not decrypt",
          noMessages: "No messages",
          you: "You",
        },
      ),
    ).toBe("");
    expect(
      chatPreview(
        {
          peerId: bobId,
          messages: [],
          unreadCount: 0,
          hasMore: false,
        },
        {
          loading: "Loading…",
          decryptFailed: "Could not decrypt",
          noMessages: "No messages",
          you: "You",
        },
      ),
    ).toBe("No messages");
    controller.stop();
  });

  it("moves a chat to the top when a new outgoing message arrives", async () => {
    const now = Date.now();
    const controller = new ChatController(alice, aliceId, session("token"), {
      now: () => now,
      outbox: {
        list: async () => [],
        put: async () => undefined,
        remove: async () => undefined,
        clear: async () => undefined,
      },
      getHistory: async () => ({ messages: [], hasMore: false }),
    });
    const old = new Date(now - 60_000).toISOString();
    (
      controller as unknown as {
        update(patch: { chats: Array<Record<string, unknown>> }): void;
      }
    ).update({
      chats: [
        {
          peerId: bobId,
          messages: [],
          unreadCount: 0,
          hasMore: false,
          lastCreatedAt: old,
        },
        {
          peerId: "c".repeat(64),
          messages: [],
          unreadCount: 0,
          hasMore: false,
          lastCreatedAt: old,
        },
      ],
    });
    controller.selectChat(bobId);
    await controller.sendText("Newest chat message");
    expect(controller.getSnapshot().chats[0]?.peerId).toBe(bobId);
    controller.stop();
  });

  it("backs off account data retries by 2s, 4s, then 8s", async () => {
    const timers: Array<{ callback: () => void; delay: number }> = [];
    let calls = 0;
    const controller = new ChatController(alice, aliceId, session("token"), {
      setTimer: ((callback: TimerHandler, delay?: number) => {
        timers.push({ callback: callback as () => void, delay: Number(delay) });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clearTimer: (() => undefined) as typeof clearTimeout,
      getConversations: async () => {
        calls++;
        throw new TypeError("network unavailable");
      },
      getContacts: async () => ({ version: "0", blob: null }),
    });
    const load = (
      controller as unknown as {
        loadAccountData(): Promise<void>;
      }
    ).loadAccountData.bind(controller);
    await load();
    expect(timers.at(-1)?.delay).toBe(2_000);
    timers.at(-1)!.callback();
    await load();
    expect(calls).toBe(2);
    expect(timers.at(-1)?.delay).toBe(4_000);
    timers.at(-1)!.callback();
    await load();
    expect(calls).toBe(3);
    expect(timers.at(-1)?.delay).toBe(8_000);
    controller.stop();
  });

  it("refreshes an expired session once for account data and retries the request", async () => {
    const seenTokens: string[] = [];
    let logins = 0;
    const controller = new ChatController(alice, aliceId, session("expired"), {
      login: async () => {
        logins++;
        return session("fresh");
      },
      getConversations: async (token) => {
        seenTokens.push(token);
        if (token === "expired") throw new ApiError(401, "unauthorized");
        return { conversations: [] };
      },
      getContacts: async () => ({ version: "0", blob: null }),
    });
    await (
      controller as unknown as { loadAccountData(): Promise<void> }
    ).loadAccountData();
    expect(seenTokens).toEqual(["expired", "fresh"]);
    expect(logins).toBe(1);
    controller.stop();
  });

  it("retries contact save on version conflict and overlays the local name", async () => {
    const latest: ContactBookResponse = {
      version: "2",
      blob: encryptContactBook({
        historyKey: alice.historyKey,
        contacts: { [bobId]: "Remote" },
      }),
    };
    let writes = 0;
    const controller = new ChatController(alice, aliceId, session("token"), {
      getContacts: async () => latest,
      putContacts: async (_token, version, blob) => {
        writes++;
        if (writes === 1) throw new ApiError(409, "version_conflict");
        expect(version).toBe("2");
        expect(
          decryptContactBook({ historyKey: alice.historyKey, blob }),
        ).toEqual({ [bobId]: "Local" });
        return { version: "3" };
      },
    });
    expect(await controller.saveContactName(bobId, "  Local  ")).toBe(true);
    expect(writes).toBe(2);
    expect(controller.getSnapshot().contacts[bobId]).toBe("Local");
  });

  it("stops contact conflict retries after three writes", async () => {
    let writes = 0;
    const controller = new ChatController(alice, aliceId, session("token"), {
      getContacts: async () => ({ version: String(writes + 1), blob: null }),
      putContacts: async () => {
        writes++;
        throw new ApiError(409, "version_conflict");
      },
    });
    expect(await controller.saveContactName(bobId, "Name")).toBe(false);
    expect(writes).toBe(3);
  });

  it("restores an encrypted queued frame even while account HTTP endpoints are unavailable", async () => {
    vi.stubGlobal("window", {});
    const frame = {
      type: "send" as const,
      clientMsgId: "00000000000000000000000000000002",
      to: bobId,
      ciphertext: "encrypted-message",
      senderCopy: encryptHistoryEntry({
        historyKey: alice.historyKey,
        clientMsgId: "00000000000000000000000000000002",
        peerId: bobId,
        text: "unsent text",
        sentAt: Date.now(),
      }),
    };
    const controller = new ChatController(alice, aliceId, session("token"), {
      outbox: {
        list: async () => [frame],
        put: async () => undefined,
        remove: async () => undefined,
        clear: async () => undefined,
      },
      getConversations: async () => {
        throw new Error("offline");
      },
      getContacts: async () => {
        throw new Error("offline");
      },
    });
    controller.start();
    await waitFor(() =>
      controller.getSnapshot().chats.some((chat) => chat.peerId === bobId),
    );
    const message = controller.getSnapshot().chats[0]?.messages[0];
    expect(message?.clientMsgId).toBe(frame.clientMsgId);
    expect(message?.text).toBe("unsent text");
    expect(message?.frame).toEqual(frame);
    controller.stop();
  });

  it("displays a history placeholder and continues after a broken payload", async () => {
    const controller = new ChatController(alice, aliceId, session("token"), {
      fetchPeerKeys: async () => userKeys(bob),
      getHistory: async () => ({
        hasMore: false,
        messages: [
          {
            id: "ok",
            seq: "1",
            direction: "out",
            clientMsgId: "00000000000000000000000000000001",
            payload: "broken",
            createdAt: "2025-01-01T00:00:00.000Z",
            deliveredAt: null,
          },
        ],
      }),
    });
    await controller.openChat(bobId);
    await waitFor(() => controller.getSnapshot().chats[0]?.hasMore === false);
    expect(controller.getSnapshot().chats[0]?.messages[0]?.decryptFailed).toBe(
      true,
    );
  });

  it("sets outgoing history status from deliveredAt and does not downgrade it", async () => {
    const idSent = "00000000000000000000000000000011";
    const idDelivered = "00000000000000000000000000000012";
    const removed: string[] = [];
    const controller = new ChatController(alice, aliceId, session("token"), {
      outbox: {
        list: async () => [],
        put: async () => undefined,
        remove: async (_userId, id) => {
          removed.push(id);
        },
        clear: async () => undefined,
      },
      fetchPeerKeys: async () => userKeys(bob),
      getHistory: async () => ({
        hasMore: false,
        messages: [
          {
            id: "history-sent",
            seq: "1",
            direction: "out",
            clientMsgId: idSent,
            payload: encryptHistoryEntry({
              historyKey: alice.historyKey,
              clientMsgId: idSent,
              peerId: bobId,
              text: "sent history",
              sentAt: Date.now(),
            }),
            createdAt: new Date().toISOString(),
            deliveredAt: null,
          },
          {
            id: "history-delivered",
            seq: "2",
            direction: "out",
            clientMsgId: idDelivered,
            payload: encryptHistoryEntry({
              historyKey: alice.historyKey,
              clientMsgId: idDelivered,
              peerId: bobId,
              text: "delivered history",
              sentAt: Date.now(),
            }),
            createdAt: new Date().toISOString(),
            deliveredAt: new Date().toISOString(),
          },
        ],
      }),
    });
    await controller.openChat(bobId);
    await waitFor(() => controller.getSnapshot().chats[0]?.hasMore === false);
    await waitFor(() => removed.length === 2);
    const messages = controller.getSnapshot().chats[0]!.messages;
    expect(messages.map((message) => message.status)).toEqual([
      "sent",
      "delivered",
    ]);
    expect(removed).toEqual([idSent, idDelivered]);
    expect(
      mergeMessages(
        [{ ...messages[1]!, status: "delivered" }],
        [{ ...messages[1]!, status: "sending" }],
      )[0]!.status,
    ).toBe("delivered");
    expect(
      mergeMessages(
        [{ ...messages[0]!, status: "sent" }],
        [{ ...messages[0]!, status: "sending" }],
      )[0]!.status,
    ).toBe("sent");
    expect(
      mergeMessages(
        [{ ...messages[1]!, status: "read" }],
        [{ ...messages[1]!, status: "delivered" }],
      )[0]!.status,
    ).toBe("read");
    controller.stop();
  });

  it("applies peer read markers from history and live frames", async () => {
    const id = "00000000000000000000000000000021";
    const controller = new ChatController(alice, aliceId, session("token"), {
      fetchPeerKeys: async () => userKeys(bob),
      getHistory: async () => ({
        hasMore: false,
        peerReadUpToSeq: "7",
        messages: [
          {
            id: "history-read",
            seq: "7",
            direction: "out",
            clientMsgId: id,
            payload: encryptHistoryEntry({
              historyKey: alice.historyKey,
              clientMsgId: id,
              peerId: bobId,
              text: "read",
              sentAt: Date.now(),
            }),
            createdAt: new Date().toISOString(),
            deliveredAt: null,
          },
        ],
      }),
    });
    await controller.openChat(bobId);
    await waitFor(() => controller.getSnapshot().chats[0]?.hasMore === false);
    expect(controller.getSnapshot().chats[0]?.messages[0]?.status).toBe("read");
    controller.stop();
  });

  it("marks outgoing messages read through the live receipt frame", async () => {
    const f = makeController({
      initialSession: session("token"),
      getHistory: async () => ({ messages: [], hasMore: false }),
    });
    f.controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await authenticate(f.sockets[0]!);
    await f.controller.openChat(bobId);
    await f.controller.sendText("outgoing");
    const sent = f.sockets[0]!.decoded().find((frame) => frame.type === "send");
    f.sockets[0]!.frame({
      type: "sent",
      clientMsgId: sent!.clientMsgId,
      id: "server-message-id",
      seq: "12",
      createdAt: new Date().toISOString(),
    });
    await waitFor(
      () => f.controller.getSnapshot().chats[0]?.messages[0]?.seq === "12",
    );
    f.sockets[0]!.frame({
      type: "read",
      from: bobId,
      upToSeq: "12",
      readAt: new Date().toISOString(),
    });
    await waitFor(
      () => f.controller.getSnapshot().chats[0]?.messages[0]?.status === "read",
    );
    f.controller.stop();
  });

  it("sends one debounced read marker only while the tab is visible", async () => {
    const f = makeController({
      initialSession: session("token"),
      isVisible: () => true,
      getHistory: async () => ({ messages: [], hasMore: false }),
    });
    f.controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await authenticate(f.sockets[0]!);
    await f.controller.openChat(bobId);
    f.sockets[0]!.frame({
      type: "message",
      id: "incoming-duplicate",
      from: bobId,
      seq: "9",
      createdAt: new Date().toISOString(),
      ciphertext: "invalid",
    });
    await waitFor(() =>
      f.controller
        .getSnapshot()
        .chats.some(
          (chat) => chat.peerId === bobId && chat.messages.length > 0,
        ),
    );
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(
      f.sockets[0]!.decoded().filter((frame) => frame.type === "read"),
    ).toEqual([{ type: "read", peerId: bobId, upToSeq: "9" }]);
    f.sockets[0]!.frame({
      type: "message",
      id: "incoming",
      from: bobId,
      seq: "9",
      createdAt: new Date().toISOString(),
      ciphertext: "invalid",
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(
      f.sockets[0]!.decoded().filter((frame) => frame.type === "read"),
    ).toHaveLength(1);
    f.controller.stop();

    const hidden = makeController({
      initialSession: session("token"),
      isVisible: () => false,
      getHistory: async () => ({ messages: [], hasMore: false }),
    });
    hidden.controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await authenticate(hidden.sockets[0]!);
    await hidden.controller.openChat(bobId);
    hidden.sockets[0]!.frame({
      type: "message",
      id: "hidden",
      from: bobId,
      seq: "10",
      createdAt: new Date().toISOString(),
      ciphertext: "invalid",
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(
      hidden.sockets[0]!.decoded().filter((frame) => frame.type === "read"),
    ).toHaveLength(0);
    hidden.controller.stop();
  });

  it("resends an unconfirmed frame after reconnect with the same payload and clientMsgId", async () => {
    vi.useFakeTimers();
    const f = makeController({
      initialSession: session("token-a"),
      random: () => 0,
    });
    f.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    f.sockets[0]!.open();
    f.sockets[0]!.frame({ type: "auth_ok" });
    await vi.advanceTimersByTimeAsync(0);
    await f.controller.openChat(bobId);
    await f.controller.sendText("first survives disconnect");
    await f.controller.sendText("second survives disconnect");
    const firstFrames = f.sockets[0]!.decoded().filter(
      (frame) => frame.type === "send",
    );
    expect(firstFrames).toHaveLength(2);
    f.sockets[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(799);
    expect(f.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sockets).toHaveLength(2);
    f.sockets[1]!.open();
    f.sockets[1]!.frame({ type: "auth_ok" });
    await vi.advanceTimersByTimeAsync(0);
    expect(
      f.sockets[1]!.decoded().filter((frame) => frame.type === "send"),
    ).toEqual(firstFrames);
    f.controller.stop();
  });

  it("limits immediate 4401 re-login to one and backs off later failures; stop prevents retries", async () => {
    vi.useFakeTimers();
    const f = makeController({
      initialSession: session("start-token"),
      random: () => 0,
    });
    f.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    f.sockets[0]!.close(4401);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.getLoginCount()).toBe(1);
    expect(f.sockets).toHaveLength(2);
    f.sockets[1]!.close(4401);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.getLoginCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(799);
    expect(f.getLoginCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.getLoginCount()).toBe(2);
    expect(f.sockets).toHaveLength(3);
    f.sockets[2]!.open();
    f.sockets[2]!.close(4401);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.getLoginCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_599);
    expect(f.getLoginCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.getLoginCount()).toBe(3);
    expect(f.sockets).toHaveLength(4);
    f.sockets[3]!.open();
    f.sockets[3]!.frame({ type: "auth_ok" });
    await vi.advanceTimersByTimeAsync(0);
    f.sockets[3]!.close(4401);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.getLoginCount()).toBe(4);
    expect(f.sockets).toHaveLength(5);
    f.controller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.getLoginCount()).toBe(4);
    expect(f.sockets).toHaveLength(5);
  });

  it("retries a failed login while offline and connects when the server returns", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const sockets: TestSocket[] = [];
    const f = makeController({
      login: async () => {
        attempts++;
        if (attempts === 1) throw new Error("offline");
        return session("online-token");
      },
      socketFactory: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      random: () => 0,
    });
    f.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.getSnapshot().connectionState).toBe("offline");
    await vi.advanceTimersByTimeAsync(800);
    await Promise.resolve();
    expect(attempts).toBe(2);
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    sockets[0]!.frame({ type: "auth_ok" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.getSnapshot().connectionState).toBe("connected");
    f.controller.stop();
  });
});

describe("ChatController linked Alice and Bob", () => {
  it("exchanges encrypted messages in both directions and reaches delivered", async () => {
    const sockets = new Map<string, TestSocket>();
    const idsByMessage = new Map<
      string,
      { sender: string; clientMsgId: string }
    >();
    let uuid = 0;
    const makeLinked = (userId: string) =>
      new TestSocketWithRouter((socket, frame) => {
        if (frame.type === "auth") {
          socket.frame({ type: "auth_ok", userId });
          return;
        }
        if (frame.type === "send") {
          const id = `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`;
          idsByMessage.set(id, {
            sender: userId,
            clientMsgId: String(frame.clientMsgId),
          });
          socket.frame({
            type: "sent",
            clientMsgId: frame.clientMsgId,
            id,
            createdAt: new Date().toISOString(),
          });
          const to = String(frame.to);
          sockets.get(to)?.frame({
            type: "message",
            id,
            from: userId,
            ciphertext: frame.ciphertext,
            createdAt: new Date().toISOString(),
          });
          return;
        }
        if (frame.type === "ack")
          for (const id of frame.ids as string[]) {
            const record = idsByMessage.get(id);
            if (record)
              sockets.get(record.sender)?.frame({
                type: "delivered",
                id,
                clientMsgId: record.clientMsgId,
                at: new Date().toISOString(),
              });
          }
      });
    const create = (userId: string, own: typeof alice, peer: typeof bob) =>
      new ChatController(own, userId, null, {
        login: async () => ({
          token: `token-${userId}`,
          expiresAt: future(),
          userId,
        }),
        fetchPeerKeys: async () => userKeys(peer),
        socketFactory: () => {
          const socket = makeLinked(userId);
          sockets.set(userId, socket);
          return socket;
        },
        sendTimeoutMs: 1000,
      });
    const aliceController = create(aliceId, alice, bob);
    const bobController = create(bobId, bob, alice);
    aliceController.start();
    bobController.start();
    await waitFor(() => sockets.size === 2);
    sockets.get(aliceId)!.open();
    sockets.get(bobId)!.open();
    await waitFor(
      () =>
        aliceController.getSnapshot().connectionState === "connected" &&
        bobController.getSnapshot().connectionState === "connected",
    );
    await aliceController.openChat(bobId);
    await bobController.openChat(aliceId);
    await aliceController.sendText("hello Bob");
    await waitFor(
      () =>
        aliceController.getSnapshot().chats[0]?.messages[0]?.status ===
        "delivered",
    );
    expect(bobController.getSnapshot().chats[0]?.messages[0]?.text).toBe(
      "hello Bob",
    );
    await bobController.sendText("hello Alice");
    await waitFor(
      () =>
        bobController.getSnapshot().chats[0]?.messages.at(-1)?.status ===
        "delivered",
    );
    expect(aliceController.getSnapshot().chats[0]?.messages.at(-1)?.text).toBe(
      "hello Alice",
    );
    aliceController.stop();
    bobController.stop();
  });
});

class TestSocketWithRouter extends TestSocket {
  constructor(
    private readonly route: (
      socket: TestSocket,
      frame: Record<string, unknown>,
    ) => void,
  ) {
    super();
  }
  override send(frame: string) {
    super.send(frame);
    this.route(this, JSON.parse(frame) as Record<string, unknown>);
  }
}
