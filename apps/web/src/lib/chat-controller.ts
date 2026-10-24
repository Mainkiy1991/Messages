import {
  decryptContactBook,
  decryptHistoryEntry,
  decryptTextMessage,
  encryptContactBook,
  encryptHistoryEntry,
  encryptTextMessage,
  newClientMsgId,
  type DerivedKeys,
} from "@messages/crypto";
import {
  getContacts,
  getConversations,
  getHistory,
  putContacts,
  type ContactBookResponse,
  type ConversationSummary,
  type HistoryMessage,
} from "./api.js";
import { indexedDbOutbox, type OutboxStore } from "./outbox.js";
import type { ServerSession } from "../session.js";
import {
  ApiError,
  getUserKeys,
  logoutFromServer,
  verifyUserKeys,
  type FetchLike,
  type UserKeys,
} from "./api.js";
import {
  ChatConnection,
  type IncomingFrame,
  type OutgoingFrame,
  type SocketState,
} from "./websocket.js";

export type SendStatus = "sending" | "sent" | "delivered" | "error";
export type ChatMessage = {
  id: string;
  clientMsgId?: string;
  text: string;
  createdAt: string;
  direction: "in" | "out";
  status?: SendStatus;
  error?: string;
  decryptFailed?: boolean;
  frame?: OutgoingFrame;
  arrivalOrder: number;
  seq?: string;
};
export type Chat = {
  peerId: string;
  messages: ChatMessage[];
  unreadCount: number;
  hasMore?: boolean;
  loadingHistory?: boolean;
  lastCreatedAt?: string;
};
export type ChatControllerState = {
  chats: Chat[];
  activePeer: string;
  connectionState: SocketState;
  error: string;
  contacts: Record<string, string>;
  contactsError: boolean;
};
export type ChatError =
  | "invalid_id"
  | "self_chat"
  | "user_not_found"
  | "bad_peer_key"
  | "server_unavailable"
  | "invalid_text"
  | "send_failed";

export type ChatControllerDependencies = {
  fetcher?: FetchLike;
  login?: (keys: DerivedKeys, fetcher?: FetchLike) => Promise<ServerSession>;
  fetchPeerKeys?: (
    peerId: string,
    token: string,
    fetcher?: FetchLike,
  ) => Promise<UserKeys>;
  logout?: (token: string, fetcher?: FetchLike) => Promise<void>;
  socketFactory?: (
    url: string,
  ) => Pick<WebSocket, "send" | "close" | "addEventListener">;
  random?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  sendTimeoutMs?: number;
  now?: () => number;
  makeClientMsgId?: () => string;
  onChange?: (state: ChatControllerState) => void;
  getConversations?: (
    token: string,
  ) => Promise<{ conversations: ConversationSummary[] }>;
  getHistory?: (
    peerId: string,
    token: string,
    before?: string,
  ) => Promise<{ messages: HistoryMessage[]; hasMore: boolean }>;
  getContacts?: (token: string) => Promise<ContactBookResponse>;
  putContacts?: (
    token: string,
    version: string,
    blob: string,
  ) => Promise<{ version: string }>;
  outbox?: OutboxStore;
};

export class ChatController {
  private readonly connection: ChatConnection;
  private readonly peerKeys = new Map<string, Uint8Array>();
  private readonly peerKeyRequests = new Map<string, Promise<Uint8Array>>();
  private arrivalOrder = 0;
  private contactsVersion = "0";
  private accountDataLoaded = false;
  private historyRequests = new Set<string>();
  private state: ChatControllerState = {
    chats: [],
    activePeer: "",
    connectionState: "offline",
    error: "",
    contacts: {},
    contactsError: false,
  };

  constructor(
    private readonly keys: DerivedKeys,
    private readonly userId: string,
    session: ServerSession | null = null,
    private readonly deps: ChatControllerDependencies = {},
  ) {
    this.connection = new ChatConnection(
      keys,
      session,
      {
        onState: (connectionState) => this.update({ connectionState }),
        onFrame: (frame) => this.handleFrame(frame),
        onSend: (clientMsgId) =>
          this.updateMessage(clientMsgId, (message) => ({
            ...message,
            status: message.status === "delivered" ? "delivered" : "sending",
            error: undefined,
          })),
        onSendTimeout: (clientMsgId) =>
          this.updateMessage(clientMsgId, (message) => ({
            ...message,
            status: message.status === "delivered" ? "delivered" : "error",
            error: message.status === "delivered" ? undefined : "send_failed",
          })),
        onSent: (clientMsgId) => {
          void (this.deps.outbox ?? indexedDbOutbox).remove(
            this.userId,
            clientMsgId,
          );
        },
      },
      {
        fetcher: deps.fetcher,
        login: deps.login,
        socketFactory: deps.socketFactory,
        random: deps.random,
        setTimer: deps.setTimer,
        clearTimer: deps.clearTimer,
        sendTimeoutMs: deps.sendTimeoutMs,
      },
    );
  }

  getSnapshot(): ChatControllerState {
    return this.state;
  }
  currentToken(): string | null {
    return this.connection.currentToken();
  }
  start(): void {
    if (typeof window !== "undefined") void this.loadAccountData();
    this.connection.start();
  }

  private async loadAccountData(): Promise<void> {
    if (this.accountDataLoaded) return;
    this.accountDataLoaded = true;
    try {
      const session = await this.connection.ensureSession();
      const [conversations, book, queued] = await Promise.all([
        (
          this.deps.getConversations ??
          ((token) => getConversations(token, this.deps.fetcher))
        )(session.token),
        (
          this.deps.getContacts ??
          ((token) => getContacts(token, this.deps.fetcher))
        )(session.token),
        (this.deps.outbox ?? indexedDbOutbox).list(this.userId),
      ]);
      this.contactsVersion = book.version;
      let contacts: Record<string, string> = {};
      let contactsError = false;
      if (book.blob) {
        try {
          contacts = decryptContactBook({
            historyKey: this.keys.historyKey,
            blob: book.blob,
          });
        } catch {
          contactsError = true;
        }
      }
      const chats = conversations.conversations.map((item) => ({
        peerId: item.peerId,
        messages: [],
        unreadCount: 0,
        hasMore: true,
        lastCreatedAt: item.lastCreatedAt,
      }));
      this.update({
        chats: mergeChats(this.state.chats, chats),
        contacts,
        contactsError,
      });
      for (const frame of queued) {
        let text = "";
        let decryptFailed = false;
        try {
          text = decryptHistoryEntry({
            historyKey: this.keys.historyKey,
            clientMsgId: frame.clientMsgId,
            peerId: frame.to,
            entry: frame.senderCopy,
          }).text;
        } catch {
          decryptFailed = true;
        }
        this.upsertMessage(frame.to, {
          id: frame.clientMsgId,
          clientMsgId: frame.clientMsgId,
          text,
          createdAt: new Date().toISOString(),
          direction: "out",
          status: "sending",
          frame,
          ...(decryptFailed ? { decryptFailed: true } : {}),
          arrivalOrder: this.arrivalOrder++,
        });
        this.connection.send(frame);
      }
    } catch {
      this.accountDataLoaded = false;
      this.update({ error: "server_unavailable" });
    }
  }

  async loadHistory(peerId = this.state.activePeer): Promise<void> {
    const chat = this.state.chats.find((item) => item.peerId === peerId);
    if (
      !chat ||
      chat.loadingHistory ||
      chat.hasMore === false ||
      this.historyRequests.has(peerId)
    )
      return;
    this.historyRequests.add(peerId);
    this.update({
      chats: this.state.chats.map((item) =>
        item.peerId === peerId ? { ...item, loadingHistory: true } : item,
      ),
    });
    try {
      const oldest = chat.messages
        .map((message) => message.seq)
        .filter((seq): seq is string => !!seq)
        .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))[0];
      const session = await this.connection.ensureSession();
      const page = await (
        this.deps.getHistory ??
        ((id, token, before) =>
          getHistory(id, token, before, this.deps.fetcher))
      )(peerId, session.token, oldest);
      const messages = await Promise.all(
        page.messages.map(async (entry) => {
          try {
            const text =
              entry.direction === "out"
                ? decryptHistoryEntry({
                    historyKey: this.keys.historyKey,
                    clientMsgId: entry.clientMsgId,
                    peerId,
                    entry: entry.payload,
                  }).text
                : decryptTextMessage({
                    recipientEncryptionPrivateKey:
                      this.keys.encryption.privateKey,
                    senderEncryptionPublicKey:
                      await this.getVerifiedPeerKey(peerId),
                    senderId: peerId,
                    recipientId: this.userId,
                    ciphertext: entry.payload,
                  }).text;
            return {
              id: entry.id,
              clientMsgId: entry.clientMsgId,
              seq: entry.seq,
              text,
              createdAt: entry.createdAt,
              direction: entry.direction,
              arrivalOrder: this.arrivalOrder++,
            } as ChatMessage;
          } catch {
            return {
              id: entry.id,
              clientMsgId: entry.clientMsgId,
              seq: entry.seq,
              text: "",
              createdAt: entry.createdAt,
              direction: entry.direction,
              decryptFailed: true,
              arrivalOrder: this.arrivalOrder++,
            } as ChatMessage;
          }
        }),
      );
      this.update({
        chats: this.state.chats.map((item) =>
          item.peerId === peerId
            ? {
                ...item,
                messages: mergeMessages(item.messages, messages),
                hasMore: page.hasMore,
                loadingHistory: false,
              }
            : item,
        ),
      });
    } catch {
      this.update({
        chats: this.state.chats.map((item) =>
          item.peerId === peerId ? { ...item, loadingHistory: false } : item,
        ),
        error: "server_unavailable",
      });
    } finally {
      this.historyRequests.delete(peerId);
    }
  }

  async saveContactName(peerId: string, value: string): Promise<boolean> {
    const name = value.trim();
    if (Array.from(name).length > 64) return false;
    const local = { ...this.state.contacts };
    if (name) local[peerId] = name;
    else delete local[peerId];
    const save =
      this.deps.putContacts ??
      ((token, version, blob) =>
        putContacts(token, version, blob, this.deps.fetcher));
    const fetchBook =
      this.deps.getContacts ??
      ((token) => getContacts(token, this.deps.fetcher));
    try {
      const session = await this.connection.ensureSession();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await save(
            session.token,
            this.contactsVersion,
            encryptContactBook({
              historyKey: this.keys.historyKey,
              contacts: local,
            }),
          );
          this.contactsVersion = result.version;
          this.update({ contacts: local, contactsError: false });
          return true;
        } catch (error) {
          if (
            !(error instanceof ApiError) ||
            error.status !== 409 ||
            error.code !== "version_conflict" ||
            attempt === 2
          )
            throw error;
          const conflict = error.data;
          const latest: ContactBookResponse =
            conflict &&
            typeof conflict.version === "string" &&
            (typeof conflict.blob === "string" || conflict.blob === null)
              ? { version: conflict.version, blob: conflict.blob }
              : await fetchBook(session.token);
          const remote = latest.blob
            ? decryptContactBook({
                historyKey: this.keys.historyKey,
                blob: latest.blob,
              })
            : {};
          if (name) remote[peerId] = name;
          else delete remote[peerId];
          Object.assign(local, remote);
          this.contactsVersion = latest.version;
        }
      }
    } catch {
      /* localized UI error is displayed by the caller */
    }
    return false;
  }

  stop(): void {
    this.connection.stop();
  }

  async logout(): Promise<void> {
    const token = this.connection.currentToken();
    this.connection.stop();
    if (!token) return;
    const logout = this.deps.logout ?? logoutFromServer;
    try {
      await logout(token, this.deps.fetcher);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) return;
      try {
        const session = await this.connection.refreshSession();
        await logout(session.token, this.deps.fetcher);
      } catch {
        /* Logout is best effort. */
      }
    }
  }

  async openChat(input: string): Promise<void> {
    const peerId = input.trim();
    if (!/^[0-9a-f]{64}$/u.test(peerId)) {
      this.setError("invalid_id");
      return;
    }
    if (peerId === this.userId) {
      this.setError("self_chat");
      return;
    }
    try {
      await this.getVerifiedPeerKey(peerId);
    } catch (error) {
      this.setError(this.peerKeyError(error));
      return;
    }
    try {
      const chats = this.state.chats.some((chat) => chat.peerId === peerId)
        ? this.state.chats
        : [
            ...this.state.chats,
            { peerId, messages: [], unreadCount: 0, hasMore: true },
          ];
      this.update({ chats, activePeer: peerId, error: "" });
      this.resetUnread(peerId);
      void this.loadHistory(peerId);
    } catch {
      this.setError("server_unavailable");
    }
  }

  selectChat(peerId: string): void {
    if (!this.state.chats.some((chat) => chat.peerId === peerId)) return;
    this.update({ activePeer: peerId, error: "" });
    this.resetUnread(peerId);
    void this.loadHistory(peerId);
  }

  closeActiveChat(): void {
    this.update({ activePeer: "" });
  }

  async sendText(text: string): Promise<void> {
    const peerId = this.state.activePeer;
    if (!peerId || !text.trim() || Array.from(text).length > 4000) {
      this.setError("invalid_text");
      return;
    }
    let recipientEncryptionPublicKey: Uint8Array;
    try {
      recipientEncryptionPublicKey = await this.getVerifiedPeerKey(peerId);
    } catch (error) {
      this.setError(this.peerKeyError(error));
      return;
    }
    try {
      const sentAt = (this.deps.now ?? Date.now)();
      const clientMsgId = (this.deps.makeClientMsgId ?? newClientMsgId)();
      const frame: OutgoingFrame = {
        type: "send",
        clientMsgId,
        to: peerId,
        ciphertext: encryptTextMessage({
          senderEncryptionPrivateKey: this.keys.encryption.privateKey,
          recipientEncryptionPublicKey,
          senderId: this.userId,
          recipientId: peerId,
          text,
          sentAt,
        }),
        senderCopy: encryptHistoryEntry({
          historyKey: this.keys.historyKey,
          clientMsgId,
          peerId,
          text,
          sentAt,
        }),
      };
      const message: ChatMessage = {
        id: clientMsgId,
        clientMsgId,
        text,
        createdAt: new Date(sentAt).toISOString(),
        direction: "out",
        status: "sending",
        frame,
        arrivalOrder: this.arrivalOrder++,
      };
      await (this.deps.outbox ?? indexedDbOutbox).put(this.userId, frame);
      this.upsertMessage(peerId, message);
      this.update({ error: "" });
      this.connection.send(frame);
    } catch {
      this.setError("server_unavailable");
    }
  }

  retryMessage(peerId: string, clientMsgId: string): void {
    const message = this.state.chats
      .find((chat) => chat.peerId === peerId)
      ?.messages.find((item) => item.clientMsgId === clientMsgId);
    if (!message?.frame) return;
    this.updateMessage(clientMsgId, (current) => ({
      ...current,
      status: "sending",
      error: undefined,
    }));
    this.connection.retryMessage(message.frame);
  }

  private async getVerifiedPeerKey(peerId: string): Promise<Uint8Array> {
    const cached = this.peerKeys.get(peerId);
    if (cached) return cached;
    const pending = this.peerKeyRequests.get(peerId);
    if (pending) return pending;
    const request = this.fetchAndVerifyPeerKey(peerId)
      .then((key) => {
        this.peerKeys.set(peerId, key);
        return key;
      })
      .finally(() => this.peerKeyRequests.delete(peerId));
    this.peerKeyRequests.set(peerId, request);
    return request;
  }

  private peerKeyError(error: unknown): ChatError {
    if (error instanceof ApiError && error.status === 404)
      return "user_not_found";
    if (
      error instanceof ApiError &&
      (error.status === 0 || error.code === "network_timeout")
    )
      return "server_unavailable";
    if (error instanceof TypeError) return "server_unavailable";
    return "bad_peer_key";
  }

  private async fetchAndVerifyPeerKey(peerId: string): Promise<Uint8Array> {
    const fetchKeys = this.deps.fetchPeerKeys ?? getUserKeys;
    let session = await this.connection.ensureSession();
    try {
      const value = await fetchKeys(peerId, session.token, this.deps.fetcher);
      return verifyUserKeys(peerId, value);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      session = await this.connection.refreshSession();
      const value = await fetchKeys(peerId, session.token, this.deps.fetcher);
      return verifyUserKeys(peerId, value);
    }
  }

  private async handleFrame(frame: IncomingFrame): Promise<void> {
    if (
      frame.type === "message" &&
      typeof frame.id === "string" &&
      typeof frame.from === "string" &&
      typeof frame.ciphertext === "string" &&
      typeof frame.createdAt === "string"
    ) {
      let text = "";
      let decryptFailed = false;
      try {
        const senderEncryptionPublicKey = await this.getVerifiedPeerKey(
          frame.from,
        );
        text = decryptTextMessage({
          recipientEncryptionPrivateKey: this.keys.encryption.privateKey,
          senderEncryptionPublicKey,
          senderId: frame.from,
          recipientId: this.userId,
          ciphertext: frame.ciphertext,
        }).text;
      } catch {
        /* Render a safe placeholder; WebSocket still acks this frame. */
        decryptFailed = true;
      }
      const message: ChatMessage = {
        id: frame.id,
        text,
        createdAt: frame.createdAt,
        direction: "in",
        ...(decryptFailed ? { decryptFailed: true } : {}),
        arrivalOrder: this.arrivalOrder++,
      };
      const existing = this.state.chats.find(
        (chat) => chat.peerId === frame.from,
      );
      const chat: Chat = existing ?? {
        peerId: frame.from,
        messages: [],
        unreadCount: 0,
      };
      const unreadCount =
        this.state.activePeer === frame.from ? 0 : chat.unreadCount + 1;
      this.upsertMessage(frame.from, message, unreadCount);
      return;
    }
    if (frame.type === "sent" && typeof frame.clientMsgId === "string") {
      this.updateMessage(frame.clientMsgId, (message) => ({
        ...message,
        id: typeof frame.id === "string" ? frame.id : message.id,
        createdAt:
          typeof frame.createdAt === "string"
            ? frame.createdAt
            : message.createdAt,
        status: message.status === "delivered" ? "delivered" : "sent",
        error: undefined,
      }));
      void (this.deps.outbox ?? indexedDbOutbox).remove(
        this.userId,
        frame.clientMsgId,
      );
      return;
    }
    if (frame.type === "delivered" && typeof frame.clientMsgId === "string") {
      this.updateMessage(frame.clientMsgId, (message) => ({
        ...message,
        status: "delivered",
        error: undefined,
      }));
      return;
    }
    if (frame.type === "error") {
      const messageError =
        frame.code === "recipient_not_found" ? "user_not_found" : "send_failed";
      if (typeof frame.clientMsgId === "string")
        this.updateMessage(frame.clientMsgId, (message) => ({
          ...message,
          status: message.status === "delivered" ? "delivered" : "error",
          error: message.status === "delivered" ? undefined : messageError,
        }));
      else
        for (const chat of this.state.chats)
          for (const message of chat.messages)
            if (message.status === "sending" && message.clientMsgId)
              this.updateMessage(message.clientMsgId, (current) => ({
                ...current,
                status: current.status === "delivered" ? "delivered" : "error",
                error: messageError,
              }));
    }
  }

  private updateMessage(
    clientMsgId: string,
    update: (message: ChatMessage) => ChatMessage,
  ): void {
    const chats = this.state.chats.map((chat) => ({
      ...chat,
      messages: chat.messages
        .map((message) =>
          message.clientMsgId === clientMsgId ? update(message) : message,
        )
        .sort(compareMessages),
    }));
    this.update({ chats });
  }

  private upsertMessage(
    peerId: string,
    message: ChatMessage,
    unreadCount?: number,
  ): void {
    const chat = this.state.chats.find((item) => item.peerId === peerId);
    const nextChat: Chat = chat
      ? {
          ...chat,
          unreadCount: unreadCount ?? chat.unreadCount,
          messages: mergeMessages(chat.messages, [message]),
        }
      : { peerId, unreadCount: unreadCount ?? 0, messages: [message] };
    const chats = chat
      ? this.state.chats.map((item) =>
          item.peerId === peerId ? nextChat : item,
        )
      : [...this.state.chats, nextChat];
    this.update({ chats });
  }

  private resetUnread(peerId: string): void {
    this.update({
      chats: this.state.chats.map((chat) =>
        chat.peerId === peerId ? { ...chat, unreadCount: 0 } : chat,
      ),
    });
  }

  private setError(error: ChatError): void {
    this.update({ error });
  }

  private update(patch: Partial<ChatControllerState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onChange?.(this.getSnapshot());
  }
}

function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.seq && b.seq && a.seq !== b.seq)
    return BigInt(a.seq) < BigInt(b.seq) ? -1 : 1;
  const time = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return (
    (Number.isFinite(time) ? time : a.createdAt.localeCompare(b.createdAt)) ||
    a.arrivalOrder - b.arrivalOrder
  );
}

export function mergeMessages(
  existing: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  const result = [...existing];
  for (const message of incoming) {
    const index = result.findIndex(
      (item) =>
        item.id === message.id ||
        (!!item.clientMsgId && item.clientMsgId === message.clientMsgId),
    );
    if (index < 0) result.push(message);
    else
      result[index] = {
        ...result[index]!,
        ...message,
        status: message.status ?? result[index]!.status,
        frame: message.frame ?? result[index]!.frame,
      };
  }
  return result.sort(compareMessages);
}

export function contactLabel(
  peerId: string,
  contacts: Record<string, string>,
): string {
  return contacts[peerId] || peerId.slice(-10);
}

function mergeChats(existing: Chat[], incoming: Chat[]): Chat[] {
  const result = [...existing];
  for (const chat of incoming) {
    const index = result.findIndex((item) => item.peerId === chat.peerId);
    if (index < 0) result.push(chat);
    else
      result[index] = {
        ...chat,
        ...result[index]!,
        hasMore: result[index]!.hasMore ?? chat.hasMore,
        lastCreatedAt: result[index]!.lastCreatedAt ?? chat.lastCreatedAt,
        messages: mergeMessages(chat.messages, result[index]!.messages),
      };
  }
  return result;
}
