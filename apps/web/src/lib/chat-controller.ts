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
import { MAX_CONVERSATIONS } from "@messages/shared";
import {
  getContacts,
  getConversations,
  getHistory,
  getHistoryAfter,
  deleteConversation,
  putContacts,
  type ContactBookResponse,
  type ConversationClear,
  type ConversationSummary,
  type HistoryMessage,
} from "./api.js";
import { indexedDbOutbox, type OutboxStore } from "./outbox.js";
import type { ServerSession } from "../session.js";
import {
  ApiError,
  getUserKeys,
  loginToServer,
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

export type SendStatus = "sending" | "sent" | "delivered" | "read" | "error";
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
  historyLoadFailed?: boolean;
  historyLoaded?: boolean;
  historyStale?: boolean;
  historyAfterMore?: boolean;
  lastCreatedAt?: string;
};
export type ChatControllerState = {
  chats: Chat[];
  activePeer: string;
  connectionState: SocketState;
  error: string;
  contacts: Record<string, string>;
  contactsError: boolean;
  waking: boolean;
  presence: Record<string, { online: boolean; lastSeenAt: string | null }>;
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
  wakingTimeoutMs?: number;
  isVisible?: () => boolean;
  deferOutgoingUntilConversations?: boolean;
  now?: () => number;
  makeClientMsgId?: () => string;
  onChange?: (state: ChatControllerState) => void;
  getConversations?: (token: string) => Promise<{
    conversations: ConversationSummary[];
    cleared?: ConversationClear[];
  }>;
  deleteConversation?: (
    peerId: string,
    token: string,
  ) => Promise<{ clearedBeforeSeq: string }>;
  getHistory?: (
    peerId: string,
    token: string,
    before?: string,
  ) => Promise<{
    messages: HistoryMessage[];
    hasMore: boolean;
    peerReadUpToSeq?: string | null;
  }>;
  getContacts?: (token: string) => Promise<ContactBookResponse>;
  getHistoryAfter?: (
    peerId: string,
    token: string,
    after: string,
  ) => Promise<{
    messages: HistoryMessage[];
    hasMore: boolean;
    peerReadUpToSeq?: string | null;
  }>;
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
  private conversationsLoaded = false;
  private contactsLoaded = false;
  private outboxLoaded = false;
  private accountDataLoading: Promise<void> | null = null;
  private readonly accountDataRetryTimers = new Map<
    "conversations" | "contacts",
    ReturnType<typeof setTimeout>
  >();
  private readonly accountDataRetryAttempts = new Map<
    "conversations" | "contacts",
    number
  >();
  private readonly accountDataFailuresAfterResponse = new Map<
    "conversations" | "contacts",
    number
  >();
  private retryAccountDataAfterLoad = false;
  private stopped = false;
  private serverResponded = false;
  private wakingExpired = false;
  private wakingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly sentReadMarkers = new Map<string, string>();
  private readonly peerReadMarkers = new Map<string, string>();
  private readonly clearedBeforeSeqs = new Map<string, string>();
  private readonly sessionLocalPeers = new Set<string>();
  private serverConversationPeers = new Set<string>();
  private readTimer: ReturnType<typeof setTimeout> | null = null;
  private historyRequests = new Map<string, Promise<boolean>>();
  private historyCatchupRequests = new Map<string, Promise<void>>();
  private presencePeerSignature = "";
  private hasConnected = false;
  private readonly deferOutgoingUntilConversations: boolean;
  private state: ChatControllerState = {
    chats: [],
    activePeer: "",
    connectionState: "offline",
    error: "",
    contacts: {},
    contactsError: false,
    waking: false,
    presence: {},
  };

  constructor(
    private readonly keys: DerivedKeys,
    private readonly userId: string,
    session: ServerSession | null = null,
    private readonly deps: ChatControllerDependencies = {},
  ) {
    this.deferOutgoingUntilConversations =
      deps.deferOutgoingUntilConversations ?? false;
    this.connection = new ChatConnection(
      keys,
      session,
      {
        onState: (connectionState) => {
          if (connectionState === "connected") this.markServerResponded();
          else if (connectionState === "offline") this.beginWaking();
          if (connectionState !== "connected" && this.hasConnected)
            this.connection.setSendingPaused(true);
          this.update({
            connectionState,
            ...(connectionState === "connected" ? {} : { presence: {} }),
          });
          if (
            connectionState === "connected" &&
            typeof window !== "undefined"
          ) {
            void this.loadAccountData();
            if (this.hasConnected) void this.refreshHistoryHeads();
            this.hasConnected = true;
          }
        },
        onFrame: (frame) => this.handleFrame(frame),
        onSend: (clientMsgId) =>
          this.updateMessage(clientMsgId, (message) => ({
            ...message,
            status: mergeStatus(message.status, "sending"),
            error: undefined,
          })),
        onSendTimeout: (clientMsgId) =>
          this.updateMessage(clientMsgId, (message) => ({
            ...message,
            status: mergeStatus(message.status, "error"),
            error:
              message.status === "delivered" ||
              message.status === "read" ||
              message.status === "sent"
                ? undefined
                : "send_failed",
          })),
      },
      {
        fetcher: deps.fetcher,
        login: async (...args) => {
          const session = await (deps.login ?? loginToServer)(...args);
          this.markServerResponded();
          return session;
        },
        socketFactory: deps.socketFactory,
        random: deps.random,
        setTimer: deps.setTimer,
        clearTimer: deps.clearTimer,
        sendTimeoutMs: deps.sendTimeoutMs,
      },
    );
    this.connection.setSendingPaused(this.deferOutgoingUntilConversations);
  }

  getSnapshot(): ChatControllerState {
    return this.state;
  }
  currentToken(): string | null {
    return this.connection.currentToken();
  }
  start(): void {
    this.stopped = false;
    if (typeof window !== "undefined") void this.loadAccountData();
    this.connection.start();
  }

  private async loadAccountData(): Promise<void> {
    if (this.accountDataLoading) return this.accountDataLoading;
    this.accountDataLoading = (async () => {
      if (!this.outboxLoaded) await this.loadOutbox();
      if (this.conversationsLoaded && this.contactsLoaded && this.outboxLoaded)
        return;
      let session: ServerSession;
      try {
        session = await this.connection.ensureSession();
      } catch (error) {
        if (this.isRetryableAccountError(error)) {
          if (!this.conversationsLoaded)
            this.scheduleAccountRetry("conversations");
          if (!this.contactsLoaded) this.scheduleAccountRetry("contacts");
        }
        return;
      }
      if (!this.conversationsLoaded)
        await this.loadConversations(session.token);
      if (!this.contactsLoaded) await this.loadContacts(session.token);
      if (this.conversationsLoaded) {
        await this.flushOutbox();
        this.connection.setSendingPaused(false);
      }
    })().finally(() => {
      this.accountDataLoading = null;
      if (this.retryAccountDataAfterLoad && !this.stopped) {
        this.retryAccountDataAfterLoad = false;
        void this.loadAccountData();
      }
    });
    return this.accountDataLoading;
  }

  private async loadOutbox(): Promise<void> {
    try {
      const queued = await (this.deps.outbox ?? indexedDbOutbox).list(
        this.userId,
      );
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
      }
      this.outboxLoaded = true;
    } catch {
      this.update({ error: "server_unavailable" });
    }
  }

  private async flushOutbox(): Promise<void> {
    try {
      const queued = await (this.deps.outbox ?? indexedDbOutbox).list(
        this.userId,
      );
      for (const frame of queued) this.connection.send(frame);
    } catch {
      this.update({ error: "server_unavailable" });
    }
  }

  private reconcileConversations(summaries: Chat[]): Chat[] {
    const serverPeers = new Set(summaries.map((chat) => chat.peerId));
    const existingChats = this.state.chats.filter(
      (chat) =>
        serverPeers.has(chat.peerId) ||
        (this.sessionLocalPeers.has(chat.peerId) &&
          !this.serverConversationPeers.has(chat.peerId)),
    );
    this.serverConversationPeers = serverPeers;
    return sortChats(mergeChats(existingChats, summaries));
  }

  private async loadConversations(token: string): Promise<void> {
    const get =
      this.deps.getConversations ??
      ((value: string) => getConversations(value, this.deps.fetcher));
    try {
      const result = await this.withFreshSession(token, get);
      if (this.stopped) return;
      for (const cleared of result.cleared ?? []) {
        await this.applyConversationClear(
          cleared.peerId,
          cleared.clearedBeforeSeq,
        );
      }
      const chats = result.conversations.map((item) => ({
        peerId: item.peerId,
        messages: [],
        unreadCount: 0,
        hasMore: true,
        lastCreatedAt: item.lastCreatedAt,
      }));
      this.update({ chats: this.reconcileConversations(chats) });
      this.conversationsLoaded = true;
      this.accountDataFailuresAfterResponse.delete("conversations");
      this.resetAccountRetry("conversations");
      void this.loadRecentPreviews(chats.map((chat) => chat.peerId));
      const activePeer = this.state.activePeer;
      const activeChat = this.state.chats.find(
        (chat) => chat.peerId === activePeer,
      );
      if (activeChat && !activeChat.historyLoaded)
        void this.loadHistory(activePeer, { silent: true });
    } catch (error) {
      this.recordAccountFailure("conversations");
      if (this.isRetryableAccountError(error))
        this.scheduleAccountRetry("conversations");
      else this.update({ error: "server_unavailable" });
    }
  }

  private async loadRecentPreviews(peerIds: string[]): Promise<void> {
    const candidates = peerIds
      .slice(0, 20)
      .filter((peerId) =>
        this.state.chats.some(
          (chat) =>
            chat.peerId === peerId &&
            chat.messages.length === 0 &&
            chat.hasMore !== false &&
            peerId !== this.state.activePeer,
        ),
      );
    let next = 0;
    const workers = Array.from(
      { length: Math.min(3, candidates.length) },
      async () => {
        while (next < candidates.length && !this.stopped) {
          const peerId = candidates[next++];
          if (peerId) await this.loadHistory(peerId, { silent: true });
        }
      },
    );
    await Promise.all(workers);
  }

  private async loadContacts(token: string): Promise<void> {
    const get =
      this.deps.getContacts ??
      ((value: string) => getContacts(value, this.deps.fetcher));
    try {
      const book = await this.withFreshSession(token, get);
      if (this.stopped) return;
      let contacts: Record<string, string> = {};
      if (book.blob) {
        contacts = decryptContactBook({
          historyKey: this.keys.historyKey,
          blob: book.blob,
        });
      }
      this.contactsVersion = book.version;
      this.update({ contacts, contactsError: false });
      this.contactsLoaded = true;
      this.accountDataFailuresAfterResponse.delete("contacts");
      this.resetAccountRetry("contacts");
    } catch (error) {
      if (this.stopped) return;
      this.recordAccountFailure("contacts");
      if (this.isRetryableAccountError(error))
        this.scheduleAccountRetry("contacts");
      else this.contactsLoaded = true;
    }
  }

  private async withFreshSession<T>(
    token: string,
    request: (token: string) => Promise<T>,
  ): Promise<T> {
    try {
      const result = await request(token);
      this.markServerResponded();
      return result;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      const session = await this.connection.refreshSession();
      const result = await request(session.token);
      this.markServerResponded();
      return result;
    }
  }

  private beginWaking(): void {
    if (
      this.stopped ||
      this.serverResponded ||
      this.wakingExpired ||
      this.state.waking
    )
      return;
    this.update({ waking: true });
    const setTimer = this.deps.setTimer ?? globalThis.setTimeout;
    this.wakingTimer = setTimer(() => {
      this.wakingTimer = null;
      if (!this.stopped && !this.serverResponded) {
        this.wakingExpired = true;
        this.update({ waking: false });
      }
    }, this.deps.wakingTimeoutMs ?? WAKING_TIMEOUT_MS);
  }

  private markServerResponded(): void {
    const firstResponse = !this.serverResponded;
    this.serverResponded = true;
    this.wakingExpired = false;
    if (this.wakingTimer)
      (this.deps.clearTimer ?? globalThis.clearTimeout)(this.wakingTimer);
    this.wakingTimer = null;
    if (this.state.waking) this.update({ waking: false });
    if (!firstResponse) return;
    const hadRetries = this.accountDataRetryTimers.size > 0;
    for (const resource of ["conversations", "contacts"] as const) {
      const timer = this.accountDataRetryTimers.get(resource);
      if (timer) (this.deps.clearTimer ?? globalThis.clearTimeout)(timer);
      this.accountDataRetryTimers.delete(resource);
    }
    if (hadRetries) {
      if (this.accountDataLoading) this.retryAccountDataAfterLoad = true;
      else void this.loadAccountData();
    }
  }

  private recordAccountFailure(resource: "conversations" | "contacts"): void {
    if (!this.serverResponded) return;
    const failures =
      (this.accountDataFailuresAfterResponse.get(resource) ?? 0) + 1;
    this.accountDataFailuresAfterResponse.set(resource, failures);
    if (resource === "contacts") this.update({ contactsError: failures >= 2 });
  }

  private isRetryableAccountError(error: unknown): boolean {
    if (error instanceof ApiError)
      return error.status === 0 || error.status >= 500;
    return error instanceof TypeError;
  }

  private scheduleAccountRetry(resource: "conversations" | "contacts"): void {
    if (this.stopped || this.accountDataRetryTimers.has(resource)) return;
    this.beginWaking();
    const attempt = this.accountDataRetryAttempts.get(resource) ?? 0;
    const delay = Math.min(60_000, 2_000 * 2 ** attempt);
    this.accountDataRetryAttempts.set(resource, attempt + 1);
    const setTimer = this.deps.setTimer ?? globalThis.setTimeout;
    const timer = setTimer(() => {
      this.accountDataRetryTimers.delete(resource);
      if (this.stopped) return;
      if (resource === "conversations" && this.conversationsLoaded)
        void this.refreshHistoryHeads();
      else void this.loadAccountData();
    }, delay);
    this.accountDataRetryTimers.set(resource, timer);
  }

  private resetAccountRetry(resource: "conversations" | "contacts"): void {
    const timer = this.accountDataRetryTimers.get(resource);
    if (timer) (this.deps.clearTimer ?? globalThis.clearTimeout)(timer);
    this.accountDataRetryTimers.delete(resource);
    this.accountDataRetryAttempts.delete(resource);
  }

  async loadHistory(
    peerId = this.state.activePeer,
    options: { silent?: boolean } = {},
  ): Promise<void> {
    const pending = this.historyRequests.get(peerId);
    if (pending) {
      const succeeded = await pending;
      if (!options.silent && !succeeded) return this.loadHistory(peerId);
      return;
    }
    const chat = this.state.chats.find((item) => item.peerId === peerId);
    if (
      !chat ||
      chat.loadingHistory ||
      chat.hasMore === false ||
      this.historyRequests.has(peerId)
    )
      return;
    const request = this.fetchHistory(peerId, chat, options.silent ?? false);
    this.historyRequests.set(peerId, request);
    await request;
  }

  private loadMissedHistory(peerId: string): Promise<void> {
    const pending = this.historyCatchupRequests.get(peerId);
    if (pending) return pending;
    const request = this.fetchMissedHistory(peerId).finally(() => {
      this.historyCatchupRequests.delete(peerId);
    });
    this.historyCatchupRequests.set(peerId, request);
    return request;
  }

  private async refreshHistoryHeads(): Promise<void> {
    try {
      const session = await this.connection.ensureSession();
      const result = await this.withFreshSession(
        session.token,
        this.deps.getConversations ??
          ((token) => getConversations(token, this.deps.fetcher)),
      );
      this.resetAccountRetry("conversations");
      for (const cleared of result.cleared ?? []) {
        await this.applyConversationClear(
          cleared.peerId,
          cleared.clearedBeforeSeq,
        );
      }
      const summaries = result.conversations.map((conversation) => ({
        peerId: conversation.peerId,
        messages: [],
        unreadCount: 0,
        hasMore: true,
        lastCreatedAt: conversation.lastCreatedAt,
      }));
      const mergedChats = this.reconcileConversations(summaries);
      const lastSeq = new Map(
        result.conversations.map((conversation) => [
          conversation.peerId,
          conversation.lastSeq,
        ]),
      );
      this.update({
        chats: mergedChats.map((chat) => {
          if (!chat.historyLoaded) return chat;
          const known = chat.messages
            .map((message) => message.seq)
            .filter((seq): seq is string => !!seq)
            .reduce((max, seq) => (BigInt(seq) > BigInt(max) ? seq : max), "0");
          const server = lastSeq.get(chat.peerId) ?? "0";
          return { ...chat, historyStale: BigInt(server) > BigInt(known) };
        }),
      });
      this.connection.setSendingPaused(false);
      void this.loadRecentPreviews(summaries.map((chat) => chat.peerId));
      const activePeer = this.state.activePeer;
      const activeChat = this.state.chats.find(
        (chat) => chat.peerId === activePeer,
      );
      if (activeChat?.historyStale) void this.loadMissedHistory(activePeer);
      else if (activeChat && !activeChat.historyLoaded)
        void this.loadHistory(activePeer, { silent: true });
    } catch {
      this.scheduleAccountRetry("conversations");
    }
  }

  private async fetchMissedHistory(peerId: string): Promise<void> {
    const chat = this.state.chats.find((item) => item.peerId === peerId);
    if (!chat?.historyLoaded || !chat.historyStale) return;
    let after = chat.messages
      .map((message) => message.seq)
      .filter((seq): seq is string => !!seq)
      .reduce((max, seq) => (BigInt(seq) > BigInt(max) ? seq : max), "0");
    while (!this.stopped) {
      const current = this.state.chats.find((item) => item.peerId === peerId);
      if (!current) return;
      const loaded = await this.fetchHistory(peerId, current, true, after);
      if (!loaded) return;
      const latest = this.state.chats
        .find((item) => item.peerId === peerId)
        ?.messages.map((message) => message.seq)
        .filter((seq): seq is string => !!seq)
        .reduce((max, seq) => (BigInt(seq) > BigInt(max) ? seq : max), after);
      const updated = this.state.chats.find((item) => item.peerId === peerId);
      if (!updated?.historyAfterMore || !latest || latest === after) {
        if (updated)
          this.update({
            chats: this.state.chats.map((item) =>
              item.peerId === peerId
                ? { ...item, historyStale: false, historyAfterMore: false }
                : item,
            ),
          });
        return;
      }
      after = latest;
    }
  }

  private async fetchHistory(
    peerId: string,
    chat: Chat,
    silent: boolean,
    after?: string,
  ): Promise<boolean> {
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
      const page = after
        ? await (
            this.deps.getHistoryAfter ??
            ((id, token, cursor) =>
              getHistoryAfter(id, token, cursor, this.deps.fetcher))
          )(peerId, session.token, after)
        : await (
            this.deps.getHistory ??
            ((id, token, before) =>
              getHistory(id, token, before, this.deps.fetcher))
          )(peerId, session.token, oldest);
      this.markServerResponded();
      if (page.peerReadUpToSeq) {
        const marker = page.peerReadUpToSeq;
        this.peerReadMarkers.set(peerId, marker);
        this.update({
          chats: this.state.chats.map((item) =>
            item.peerId === peerId
              ? {
                  ...item,
                  messages: item.messages.map((message) =>
                    message.direction === "out" &&
                    message.seq &&
                    BigInt(message.seq) <= BigInt(marker)
                      ? {
                          ...message,
                          status: mergeStatus(message.status, "read"),
                        }
                      : message,
                  ),
                }
              : item,
          ),
        });
      }
      const threshold = this.clearedBeforeSeqs.get(peerId);
      const visibleMessages = threshold
        ? page.messages.filter((entry) => BigInt(entry.seq) > BigInt(threshold))
        : page.messages;
      const messages = await Promise.all(
        visibleMessages.map(async (entry) => {
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
              ...(entry.direction === "out"
                ? {
                    status:
                      page.peerReadUpToSeq &&
                      BigInt(entry.seq) <= BigInt(page.peerReadUpToSeq)
                        ? "read"
                        : entry.deliveredAt
                          ? "delivered"
                          : "sent",
                  }
                : {}),
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
              ...(entry.direction === "out"
                ? {
                    status:
                      page.peerReadUpToSeq &&
                      BigInt(entry.seq) <= BigInt(page.peerReadUpToSeq)
                        ? "read"
                        : entry.deliveredAt
                          ? "delivered"
                          : "sent",
                  }
                : {}),
              decryptFailed: true,
              arrivalOrder: this.arrivalOrder++,
            } as ChatMessage;
          }
        }),
      );
      this.update({
        chats: sortChats(
          this.state.chats.map((item) =>
            item.peerId === peerId
              ? {
                  ...item,
                  messages: mergeMessages(item.messages, messages),
                  hasMore: after ? item.hasMore : page.hasMore,
                  historyLoaded: true,
                  ...(after ? { historyAfterMore: page.hasMore } : {}),
                  loadingHistory: false,
                  historyLoadFailed: false,
                }
              : item,
          ),
        ),
      });
      await Promise.all(
        page.messages
          .filter((entry) => entry.direction === "out")
          .map(async (entry) => {
            try {
              await (this.deps.outbox ?? indexedDbOutbox).remove(
                this.userId,
                entry.clientMsgId,
              );
            } catch {
              console.warn("Could not remove acknowledged outbox item");
            }
          }),
      );
      if (this.state.activePeer === peerId) this.scheduleRead(peerId);
      return true;
    } catch {
      this.update({
        chats: this.state.chats.map((item) =>
          item.peerId === peerId
            ? { ...item, loadingHistory: false, historyLoadFailed: true }
            : item,
        ),
        ...(silent ? {} : { error: "server_unavailable" }),
      });
      return false;
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
    this.stopped = true;
    if (this.wakingTimer)
      (this.deps.clearTimer ?? globalThis.clearTimeout)(this.wakingTimer);
    this.wakingTimer = null;
    for (const timer of this.accountDataRetryTimers.values())
      (this.deps.clearTimer ?? globalThis.clearTimeout)(timer);
    this.accountDataRetryTimers.clear();
    this.connection.stop();
  }

  async logout(): Promise<void> {
    const token = this.connection.currentToken();
    this.connection.stop();
    this.stop();
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
    if (
      !this.serverConversationPeers.has(peerId) &&
      !this.state.chats.some((chat) => chat.peerId === peerId)
    )
      this.sessionLocalPeers.add(peerId);
    try {
      const now = new Date((this.deps.now ?? Date.now)()).toISOString();
      const chats = this.state.chats.some((chat) => chat.peerId === peerId)
        ? this.state.chats
        : [
            ...this.state.chats,
            {
              peerId,
              messages: [],
              unreadCount: 0,
              hasMore: true,
              lastCreatedAt: now,
            },
          ];
      this.update({ chats: sortChats(chats), activePeer: peerId, error: "" });
      this.resetUnread(peerId);
      const chat = this.state.chats.find((item) => item.peerId === peerId);
      if (chat?.historyStale) void this.loadMissedHistory(peerId);
      else if (!chat?.historyLoaded) void this.loadHistory(peerId);
      this.scheduleRead(peerId);
    } catch {
      this.setError("server_unavailable");
    }
  }

  selectChat(peerId: string): void {
    if (!this.state.chats.some((chat) => chat.peerId === peerId)) return;
    this.update({ activePeer: peerId, error: "" });
    this.resetUnread(peerId);
    const chat = this.state.chats.find((item) => item.peerId === peerId);
    if (chat?.historyStale) void this.loadMissedHistory(peerId);
    else if (!chat?.historyLoaded) void this.loadHistory(peerId);
    this.scheduleRead(peerId);
  }

  visibilityChanged(): void {
    if (this.isVisible() && this.state.activePeer)
      this.scheduleRead(this.state.activePeer);
  }

  private isVisible(): boolean {
    return (
      this.deps.isVisible?.() ??
      (typeof document !== "undefined" &&
        document.visibilityState === "visible")
    );
  }

  closeActiveChat(): void {
    this.update({ activePeer: "" });
  }

  async deleteChat(peerId: string): Promise<boolean> {
    let result: { clearedBeforeSeq: string };
    try {
      const session = await this.connection.ensureSession();
      const remove =
        this.deps.deleteConversation ??
        ((id: string, token: string) =>
          deleteConversation(id, token, this.deps.fetcher));
      result = await this.withFreshSession(session.token, (token) =>
        remove(peerId, token),
      );
    } catch {
      this.update({ error: "delete_failed" });
      return false;
    }
    try {
      await this.applyConversationClear(peerId, result.clearedBeforeSeq);
      this.update({ error: "" });
      return true;
    } catch {
      this.update({ error: "outbox_clear_failed" });
      return false;
    }
  }

  private async applyConversationClear(
    peerId: string,
    clearedBeforeSeq: string,
  ): Promise<void> {
    if (!/^\d{1,19}$/u.test(clearedBeforeSeq)) return;
    const previous = this.clearedBeforeSeqs.get(peerId) ?? "0";
    const threshold =
      BigInt(clearedBeforeSeq) > BigInt(previous) ? clearedBeforeSeq : previous;
    this.clearedBeforeSeqs.set(peerId, threshold);
    this.sessionLocalPeers.delete(peerId);
    this.connection.clearPeer(peerId);
    const chats = this.state.chats
      .map((chat) =>
        chat.peerId === peerId
          ? {
              ...chat,
              unreadCount: 0,
              messages: chat.messages.filter(
                (message) =>
                  !!message.seq && BigInt(message.seq) > BigInt(threshold),
              ),
            }
          : chat,
      )
      .filter((chat) => chat.peerId !== peerId || chat.messages.length > 0);
    this.update({
      chats,
      ...(this.state.activePeer === peerId &&
      !chats.some((chat) => chat.peerId === peerId)
        ? { activePeer: "" }
        : {}),
    });
    const outbox = this.deps.outbox ?? indexedDbOutbox;
    try {
      if (outbox.removeForPeer) {
        await outbox.removeForPeer(this.userId, peerId);
      } else {
        const queued = await outbox.list(this.userId);
        await Promise.all(
          queued
            .filter((frame) => frame.to === peerId)
            .map((frame) => outbox.remove(this.userId, frame.clientMsgId)),
        );
      }
    } catch (error) {
      this.update({ error: "outbox_clear_failed" });
      throw error;
    }
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
      this.markServerResponded();
      return verifyUserKeys(peerId, value);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      session = await this.connection.refreshSession();
      const value = await fetchKeys(peerId, session.token, this.deps.fetcher);
      this.markServerResponded();
      return verifyUserKeys(peerId, value);
    }
  }

  private async handleFrame(frame: IncomingFrame): Promise<void> {
    if (
      frame.type === "conversation_cleared" &&
      typeof frame.peerId === "string" &&
      typeof frame.clearedBeforeSeq === "string"
    ) {
      await this.applyConversationClear(frame.peerId, frame.clearedBeforeSeq);
      return;
    }
    if (frame.type === "presence" && Array.isArray(frame.presences)) {
      const presence = { ...this.state.presence };
      for (const item of frame.presences) {
        if (!item || typeof item !== "object") continue;
        const value = item as Record<string, unknown>;
        if (
          typeof value.peerId !== "string" ||
          typeof value.online !== "boolean"
        )
          continue;
        presence[value.peerId] = {
          online: value.online,
          lastSeenAt:
            typeof value.lastSeenAt === "string" ? value.lastSeenAt : null,
        };
      }
      this.update({ presence });
      return;
    }
    if (
      frame.type === "message" &&
      typeof frame.id === "string" &&
      typeof frame.from === "string" &&
      typeof frame.ciphertext === "string" &&
      typeof frame.createdAt === "string"
    ) {
      const clearedBeforeSeq = this.clearedBeforeSeqs.get(frame.from);
      if (
        typeof frame.seq === "string" &&
        /^\d+$/u.test(frame.seq) &&
        clearedBeforeSeq &&
        BigInt(frame.seq) <= BigInt(clearedBeforeSeq)
      )
        return;
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
        ...(typeof frame.seq === "string" && /^\d+$/u.test(frame.seq)
          ? { seq: frame.seq }
          : {}),
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
      if (this.state.activePeer === frame.from) this.scheduleRead(frame.from);
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
        seq:
          typeof frame.seq === "string" && /^\d+$/u.test(frame.seq)
            ? frame.seq
            : message.seq,
        status: mergeStatus(message.status, "sent"),
        error: undefined,
      }));
      await (this.deps.outbox ?? indexedDbOutbox).remove(
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
    if (
      frame.type === "read" &&
      typeof frame.from === "string" &&
      typeof frame.upToSeq === "string" &&
      /^\d+$/u.test(frame.upToSeq)
    ) {
      const marker = frame.upToSeq;
      this.peerReadMarkers.set(frame.from, marker);
      this.update({
        chats: this.state.chats.map((chat) =>
          chat.peerId === frame.from
            ? {
                ...chat,
                messages: chat.messages.map((message) =>
                  message.direction === "out" &&
                  message.seq &&
                  BigInt(message.seq) <= BigInt(marker)
                    ? {
                        ...message,
                        status: mergeStatus(message.status, "read"),
                        error: undefined,
                      }
                    : message,
                ),
              }
            : chat,
        ),
      });
      return;
    }
    if (frame.type === "error") {
      const messageError =
        frame.code === "recipient_not_found" ? "user_not_found" : "send_failed";
      if (typeof frame.clientMsgId === "string")
        this.updateMessage(frame.clientMsgId, (message) => ({
          ...message,
          status:
            message.status === "read" || message.status === "delivered"
              ? message.status
              : "error",
          error:
            message.status === "read" || message.status === "delivered"
              ? undefined
              : messageError,
        }));
      else
        for (const chat of this.state.chats)
          for (const message of chat.messages)
            if (message.status === "sending" && message.clientMsgId)
              this.updateMessage(message.clientMsgId, (current) => ({
                ...current,
                status:
                  current.status === "read" || current.status === "delivered"
                    ? current.status
                    : "error",
                error: messageError,
              }));
    }
  }

  private scheduleRead(peerId: string): void {
    if (this.stopped || this.state.activePeer !== peerId || !this.isVisible())
      return;
    const incoming =
      this.state.chats
        .find((chat) => chat.peerId === peerId)
        ?.messages.filter(
          (message) => message.direction === "in" && message.seq,
        )
        .map((message) => message.seq!) ?? [];
    if (!incoming.length) return;
    const target = incoming.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
    const previous = this.sentReadMarkers.get(peerId);
    if (previous && BigInt(target) <= BigInt(previous)) return;
    if (this.readTimer)
      (this.deps.clearTimer ?? globalThis.clearTimeout)(this.readTimer);
    this.readTimer = (this.deps.setTimer ?? globalThis.setTimeout)(() => {
      this.readTimer = null;
      if (this.state.activePeer === peerId && this.isVisible()) {
        const prior = this.sentReadMarkers.get(peerId);
        if (!prior || BigInt(target) > BigInt(prior)) {
          this.sentReadMarkers.set(peerId, target);
          this.connection.sendRead(peerId, target);
        }
      }
    }, 300);
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
    this.update({ chats: sortChats(chats) });
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
    this.update({ chats: sortChats(chats) });
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
    if (patch.chats) {
      const ids = this.state.chats
        .map((chat) => chat.peerId)
        .slice(0, MAX_CONVERSATIONS);
      const signature = ids.join(",");
      if (signature !== this.presencePeerSignature) {
        this.presencePeerSignature = signature;
        this.connection.setPresencePeers(ids);
      }
    }
    this.deps.onChange?.(this.getSnapshot());
  }
}

export const WAKING_TIMEOUT_MS = 90_000;

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
        status: mergeStatus(result[index]!.status, message.status),
        frame: message.frame ?? result[index]!.frame,
      };
  }
  return result.sort(compareMessages);
}

export function chatPreview(
  chat: Chat,
  labels: {
    loading: string;
    decryptFailed: string;
    noMessages: string;
    you: string;
  },
): string {
  if (chat.loadingHistory) return labels.loading;
  const latest = chat.messages.at(-1);
  if (latest)
    return latest.decryptFailed
      ? labels.decryptFailed
      : `${latest.direction === "out" ? `${labels.you}: ` : ""}${latest.text}`;
  return chat.hasMore === false ? labels.noMessages : "";
}

function sortChats(chats: Chat[]): Chat[] {
  return chats.slice().sort((a, b) => {
    const aTime = a.messages.at(-1)?.createdAt ?? a.lastCreatedAt ?? "";
    const bTime = b.messages.at(-1)?.createdAt ?? b.lastCreatedAt ?? "";
    return bTime.localeCompare(aTime);
  });
}

function mergeStatus(
  current: SendStatus | undefined,
  incoming: SendStatus | undefined,
): SendStatus | undefined {
  if (!incoming) return current;
  if (!current) return incoming;
  if (incoming === "error")
    return current === "sent" || current === "delivered" || current === "read"
      ? current
      : "error";
  if (current === "error") return incoming;
  const rank: Record<Exclude<SendStatus, "error">, number> = {
    sending: 0,
    sent: 1,
    delivered: 2,
    read: 3,
  };
  return rank[incoming] > rank[current] ? incoming : current;
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
