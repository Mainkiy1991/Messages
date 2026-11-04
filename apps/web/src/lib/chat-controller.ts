import {
  base64ToBytes,
  decryptContactBook,
  decryptHistoryEntry,
  decryptTextMessage,
  encryptContactBook,
  encryptDeleteAnswerMessage,
  encryptDeleteRequestMessage,
  encryptHistoryDeleteAnswerEntry,
  encryptHistoryDeleteRequestEntry,
  encryptHistoryEntry,
  encryptTextMessage,
  MAX_EDIT_REV,
  newClientMsgId,
  newReplayMessageId,
  type DecryptedMessage,
  type DerivedKeys,
} from "@messages/crypto";
import { MAX_CONVERSATIONS } from "@messages/shared";
import {
  getContacts,
  getConversations,
  getHistory,
  getHistoryAfter,
  getHistoryChangedAfter,
  updateMessage,
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
/** Where a delete request of the original author stands in this chat. */
export type DeletionStatus = "pending" | "accepted" | "declined";
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
  replayId?: string;
  replayAuthor?: string;
  countedUnread?: boolean;
  edited?: boolean;
  deletion?: DeletionStatus;
  /** Edit revision of the row; absent or zero means the original text. */
  rev?: number;
  /** Decrypted send time, which stays the same after an edit. */
  sentAt?: number;
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
  | "user_not_found"
  | "bad_peer_key"
  | "server_unavailable"
  | "invalid_text"
  | "send_failed";
/** Why an edit was rejected; the UI of the edit action is a separate task. */
export type SendEditError =
  | ChatError
  | "unknown_message"
  | "not_editable"
  | "edit_pending"
  | "edit_limit"
  | "message_deleted";
export type SendEditResult = { ok: true } | { ok: false; error: SendEditError };
/** Why a delete request or answer was rejected; the UI is a separate task. */
export type SendDeleteError =
  | ChatError
  | "unknown_message"
  | "not_deletable"
  | "message_pending"
  | "already_requested"
  | "no_request"
  | "already_answered";
export type SendDeleteResult =
  { ok: true } | { ok: false; error: SendDeleteError };

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
  /** Rows changed after a change number, for catching up after a reconnect. */
  getHistoryChangedAfter?: (
    peerId: string,
    token: string,
    changedAfter: string,
  ) => Promise<{
    messages: HistoryMessage[];
    hasMore: boolean;
    peerReadUpToSeq?: string | null;
  }>;
  /** Replaces the content of your own row; the answer is an empty 204. */
  updateMessage?: (
    id: string,
    ciphertext: string,
    senderCopy: string,
    token: string,
  ) => Promise<void>;
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
  /** Row IDs whose edit request is still on its way to the server. */
  private readonly pendingEdits = new Set<string>();
  /** Highest change number of a chat whose rows are already applied here. */
  private readonly knownChangeSeqs = new Map<string, string>();
  /** Last change number the conversation list reported per chat. */
  private readonly serverChangeSeqs = new Map<string, string>();
  /** Delete requests and answers per (chat, original author, target ID). */
  private readonly deleteStates = new Map<string, DeleteState>();
  private readonly clearedBeforeSeqs = new Map<string, string>();
  private readonly sessionLocalPeers = new Set<string>();
  private serverConversationPeers = new Set<string>();
  private readTimer: ReturnType<typeof setTimeout> | null = null;
  private historyRequests = new Map<string, Promise<boolean>>();
  private historyCatchupRequests = new Map<string, Promise<void>>();
  private changeCatchupRequests = new Map<string, Promise<void>>();
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
        let replayId: string | undefined;
        let rev: number | undefined;
        let sentAt: number | undefined;
        let createdAt = new Date().toISOString();
        let decryptFailed = false;
        /* Delete requests and answers wait instead of a placeholder. */
        let queuedState = false;
        /* Rows of the old edit mechanism leave the queue instead of sending. */
        let dropFrame = false;
        try {
          const decrypted = decryptHistoryEntry({
            historyKey: this.keys.historyKey,
            clientMsgId: frame.clientMsgId,
            peerId: frame.to,
            senderId: this.userId,
            entry: frame.senderCopy,
          });
          if (decrypted.type === "edit") {
            dropFrame = true;
          } else if (decrypted.type === "delete_request") {
            queuedState = true;
            if (decrypted.target)
              this.applyDeleteRequest({
                peerId: frame.to,
                author: this.userId,
                targetId: decrypted.target,
              });
          } else if (decrypted.type === "delete_answer") {
            queuedState = true;
            if (decrypted.target && typeof decrypted.accept === "boolean")
              this.applyDeleteAnswer({
                peerId: frame.to,
                author: this.userId,
                originalAuthor: frame.to,
                targetId: decrypted.target,
                accept: decrypted.accept,
              });
          } else {
            text = decrypted.text ?? "";
            replayId = decrypted.id;
            rev = decrypted.rev ?? 0;
            sentAt = decrypted.sentAt;
            if (decrypted.sentAt !== undefined)
              createdAt = new Date(decrypted.sentAt).toISOString();
          }
        } catch {
          decryptFailed = true;
        }
        if (dropFrame) {
          try {
            await (this.deps.outbox ?? indexedDbOutbox).remove(
              this.userId,
              frame.clientMsgId,
            );
          } catch {
            console.warn("Could not remove a queued edit row");
          }
          continue;
        }
        if (queuedState) continue;
        this.upsertMessage(frame.to, {
          id: frame.clientMsgId,
          clientMsgId: frame.clientMsgId,
          ...(replayId ? { replayId, replayAuthor: this.userId } : {}),
          text,
          createdAt,
          direction: "out",
          status: "sending",
          frame,
          ...(rev ? { rev, edited: true } : {}),
          ...(sentAt !== undefined ? { sentAt } : {}),
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
      for (const item of result.conversations)
        this.serverChangeSeqs.set(item.peerId, item.lastChangeSeq ?? "0");
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

  /** Change numbers are decimal strings; a missing value means zero. */
  private knownChangeSeq(peerId: string): string {
    return this.knownChangeSeqs.get(peerId) ?? "0";
  }

  private raiseKnownChangeSeq(peerId: string, value?: string | null): void {
    if (typeof value !== "string" || !/^\d+$/u.test(value)) return;
    if (BigInt(value) > BigInt(this.knownChangeSeq(peerId)))
      this.knownChangeSeqs.set(peerId, value);
  }

  private hasPendingChanges(peerId: string): boolean {
    const server = this.serverChangeSeqs.get(peerId) ?? "0";
    return BigInt(server) > BigInt(this.knownChangeSeq(peerId));
  }

  /**
   * Edits and erasures of a loaded chat are picked up after a reconnect: the
   * conversation list only reports the newest change number, so the rows above
   * the known one are read through `changedAfter`. The first request keeps a
   * reserve of one hundred numbers because a number is handed out before its
   * transaction commits, so an older row may appear behind the cursor.
   */
  private loadChangedHistory(peerId: string): Promise<void> {
    const pending = this.changeCatchupRequests.get(peerId);
    if (pending) return pending;
    const request = this.fetchChangedHistory(peerId).finally(() => {
      this.changeCatchupRequests.delete(peerId);
    });
    this.changeCatchupRequests.set(peerId, request);
    return request;
  }

  private async fetchChangedHistory(peerId: string): Promise<void> {
    if (!this.hasPendingChanges(peerId)) return;
    const known = BigInt(this.knownChangeSeq(peerId));
    let cursor =
      known > CHANGE_CATCHUP_RESERVE
        ? (known - CHANGE_CATCHUP_RESERVE).toString()
        : "0";
    while (!this.stopped) {
      let page: {
        messages: HistoryMessage[];
        hasMore: boolean;
      };
      try {
        const session = await this.connection.ensureSession();
        const get =
          this.deps.getHistoryChangedAfter ??
          ((id: string, token: string, after: string) =>
            getHistoryChangedAfter(id, token, after, this.deps.fetcher));
        page = await this.withFreshSession(session.token, (token) =>
          get(peerId, token, cursor),
        );
        this.markServerResponded();
      } catch {
        /* The known number stays, so the next connection repeats the request. */
        return;
      }
      let next = cursor;
      for (const entry of page.messages) {
        const changeSeq = entry.changeSeq;
        if (typeof changeSeq !== "string" || !/^\d+$/u.test(changeSeq))
          continue;
        if (BigInt(changeSeq) > BigInt(next)) next = changeSeq;
        /* Erased rows and locally cleared rows have nothing to apply. */
        if (entry.deleted || !/^\d+$/u.test(entry.seq)) continue;
        const threshold = this.clearedBeforeSeqs.get(peerId);
        if (threshold && BigInt(entry.seq) <= BigInt(threshold)) continue;
        await this.acceptUpdatedRow({
          peerId,
          direction: entry.direction,
          rowId: entry.id,
          clientMsgId: entry.clientMsgId,
          payload: entry.payload,
        });
      }
      this.raiseKnownChangeSeq(peerId, next);
      if (!page.hasMore || next === cursor) break;
      cursor = next;
    }
    if (this.stopped) return;
    this.raiseKnownChangeSeq(peerId, this.serverChangeSeqs.get(peerId));
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
      for (const conversation of result.conversations)
        this.serverChangeSeqs.set(
          conversation.peerId,
          conversation.lastChangeSeq ?? "0",
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
      for (const chat of this.state.chats)
        if (chat.historyLoaded && this.hasPendingChanges(chat.peerId))
          void this.loadChangedHistory(chat.peerId);
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
      /* Erased rows are skipped here; the placeholder is a later task. */
      const visibleMessages = page.messages.filter(
        (entry) =>
          !entry.deleted &&
          (!threshold || BigInt(entry.seq) > BigInt(threshold)),
      );
      const messages = await Promise.all(
        visibleMessages.map(async (entry) => {
          try {
            const decrypted =
              entry.direction === "out"
                ? decryptHistoryEntry({
                    historyKey: this.keys.historyKey,
                    clientMsgId: entry.clientMsgId,
                    peerId,
                    senderId: this.userId,
                    entry: entry.payload,
                  })
                : decryptTextMessage({
                    recipientEncryptionPrivateKey:
                      this.keys.encryption.privateKey,
                    senderEncryptionPublicKey:
                      await this.getVerifiedPeerKey(peerId),
                    senderId: peerId,
                    recipientId: this.userId,
                    ciphertext: entry.payload,
                  });
            if (decrypted.type === "delete_request") {
              /* Requests and answers are rows of the history, not messages. */
              if (decrypted.target)
                this.applyDeleteRequest({
                  peerId,
                  author: entry.direction === "out" ? this.userId : peerId,
                  targetId: decrypted.target,
                  seq: entry.seq,
                });
              return null;
            }
            if (decrypted.type === "delete_answer") {
              if (decrypted.target && typeof decrypted.accept === "boolean")
                this.applyDeleteAnswer({
                  peerId,
                  author: entry.direction === "out" ? this.userId : peerId,
                  originalAuthor:
                    entry.direction === "out" ? peerId : this.userId,
                  targetId: decrypted.target,
                  accept: decrypted.accept,
                  seq: entry.seq,
                });
              return null;
            }
            if (decrypted.type && decrypted.type !== "text") return null;
            return {
              id: entry.id,
              clientMsgId: entry.clientMsgId,
              seq: entry.seq,
              text: decrypted.text ?? "",
              ...(decrypted.id
                ? {
                    replayId: decrypted.id,
                    replayAuthor:
                      entry.direction === "out" ? this.userId : peerId,
                  }
                : {}),
              createdAt:
                decrypted.sentAt !== undefined
                  ? new Date(decrypted.sentAt).toISOString()
                  : entry.createdAt,
              direction: entry.direction,
              ...plainEditFields(decrypted),
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
            if (isV2Envelope(entry.payload)) return null;
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
      ).then((items) =>
        items.filter((item): item is ChatMessage => item !== null),
      );
      this.update({
        chats: sortChats(
          this.state.chats.map((item) =>
            item.peerId === peerId
              ? (() => {
                  return {
                    ...item,
                    ...(() => {
                      const reconciled = unreadAfterHistoryMerge(
                        item,
                        messages,
                      );
                      return {
                        unreadCount: reconciled.unreadCount,
                        messages: this.applyStoredEdits(
                          peerId,
                          mergeMessages(reconciled.messages, messages),
                        ),
                      };
                    })(),
                    hasMore: after ? item.hasMore : page.hasMore,
                    historyLoaded: true,
                    ...(after ? { historyAfterMore: page.hasMore } : {}),
                    loadingHistory: false,
                    historyLoadFailed: false,
                  };
                })()
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
      /* The first page of a chat accepts the change number of the list. */
      if (!after && !oldest)
        this.raiseKnownChangeSeq(peerId, this.serverChangeSeqs.get(peerId));
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
    /* The saved chat is named by the translation and never enters the contact book. */
    if (peerId === this.userId) return true;
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
      this.openSavedChat();
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
    if (peerId === this.userId) {
      this.openSavedChat();
      return;
    }
    if (!this.state.chats.some((chat) => chat.peerId === peerId)) return;
    this.update({ activePeer: peerId, error: "" });
    this.resetUnread(peerId);
    const chat = this.state.chats.find((item) => item.peerId === peerId);
    if (chat?.historyStale) void this.loadMissedHistory(peerId);
    else if (!chat?.historyLoaded) void this.loadHistory(peerId);
    this.scheduleRead(peerId);
  }

  /**
   * Saved messages: a chat with your own ID. Notes are encrypted and stored
   * like any other message, so they sync between your devices.
   */
  private openSavedChat(): void {
    const peerId = this.userId;
    if (
      !this.serverConversationPeers.has(peerId) &&
      !this.state.chats.some((chat) => chat.peerId === peerId)
    )
      this.sessionLocalPeers.add(peerId);
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
    if (
      !peerId ||
      !text.trim() ||
      Array.from(text).length > MAX_MESSAGE_CHARS
    ) {
      this.setError("invalid_text");
      return;
    }
    let recipientEncryptionPublicKey: Uint8Array;
    try {
      recipientEncryptionPublicKey =
        peerId === this.userId
          ? this.keys.encryption.publicKey
          : await this.getVerifiedPeerKey(peerId);
    } catch (error) {
      this.setError(this.peerKeyError(error));
      return;
    }
    try {
      const sentAt = (this.deps.now ?? Date.now)();
      const clientMsgId = (this.deps.makeClientMsgId ?? newClientMsgId)();
      const replayId = newReplayMessageId();
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
          messageId: replayId,
        }),
        senderCopy: encryptHistoryEntry({
          historyKey: this.keys.historyKey,
          clientMsgId,
          peerId,
          senderId: this.userId,
          messageId: replayId,
          text,
          sentAt,
        }),
      };
      const message: ChatMessage = {
        id: clientMsgId,
        clientMsgId,
        replayId,
        replayAuthor: this.userId,
        text,
        createdAt: new Date(sentAt).toISOString(),
        direction: "out",
        status: "sending",
        frame,
        rev: 0,
        sentAt,
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

  /**
   * Replaces the text of your own sent message in place: PUT /messages/:id with
   * the same envelope as the original row (same message ID, same sentAt, a new
   * revision). There is no queue and no retry: without a connection the edit
   * fails and the text stays in the composer.
   */
  async sendEdit(
    peerId: string,
    targetId: string,
    text: string,
  ): Promise<SendEditResult> {
    const original = this.state.chats
      .find((chat) => chat.peerId === peerId)
      ?.messages.find((message) => message.replayId === targetId);
    if (!original) return { ok: false, error: "unknown_message" };
    if (
      original.decryptFailed ||
      original.direction !== "out" ||
      original.replayAuthor !== this.userId
    )
      return { ok: false, error: "not_editable" };
    if (original.status === "sending" || this.pendingEdits.has(original.id))
      return { ok: false, error: "edit_pending" };
    if (!original.clientMsgId || !original.seq || original.status === "error")
      return { ok: false, error: "not_editable" };
    /* A hidden or requested message is not editable until the answer declines. */
    if (original.deletion === "pending" || original.deletion === "accepted")
      return { ok: false, error: "not_editable" };
    if (!text.trim() || Array.from(text).length > MAX_MESSAGE_CHARS)
      return { ok: false, error: "invalid_text" };
    const rev = (original.rev ?? 0) + 1;
    if (rev > MAX_EDIT_REV) return { ok: false, error: "edit_limit" };
    let recipientEncryptionPublicKey: Uint8Array;
    try {
      recipientEncryptionPublicKey =
        peerId === this.userId
          ? this.keys.encryption.publicKey
          : await this.getVerifiedPeerKey(peerId);
    } catch (error) {
      return { ok: false, error: this.peerKeyError(error) };
    }
    /* The row keeps the sent time of the original, so its place is stable. */
    const sentAt = original.sentAt ?? Date.parse(original.createdAt);
    let ciphertext: string;
    let senderCopy: string;
    try {
      ciphertext = encryptTextMessage({
        senderEncryptionPrivateKey: this.keys.encryption.privateKey,
        recipientEncryptionPublicKey,
        senderId: this.userId,
        recipientId: peerId,
        text,
        sentAt,
        messageId: targetId,
        rev,
      });
      senderCopy = encryptHistoryEntry({
        historyKey: this.keys.historyKey,
        clientMsgId: original.clientMsgId,
        peerId,
        senderId: this.userId,
        messageId: targetId,
        text,
        sentAt,
        rev,
      });
    } catch {
      return { ok: false, error: "send_failed" };
    }
    this.pendingEdits.add(original.id);
    try {
      const session = await this.connection.ensureSession();
      const put =
        this.deps.updateMessage ??
        ((id: string, cipher: string, copy: string, token: string) =>
          updateMessage(id, cipher, copy, token, this.deps.fetcher));
      await this.withFreshSession(session.token, (token) =>
        put(original.id, ciphertext, senderCopy, token),
      );
    } catch (error) {
      return { ok: false, error: editRequestError(error) };
    } finally {
      this.pendingEdits.delete(original.id);
    }
    this.applyInPlaceText(peerId, original.id, "out", text, rev);
    this.update({ error: "" });
    return { ok: true };
  }

  /**
   * Asks the peer to hide your own message. The request travels as a normal
   * encrypted frame (queue, statuses and retries are shared with text) and is
   * applied locally right after it is queued.
   */
  async sendDeleteRequest(
    peerId: string,
    targetId: string,
  ): Promise<SendDeleteResult> {
    const original = this.state.chats
      .find((chat) => chat.peerId === peerId)
      ?.messages.find((message) => message.replayId === targetId);
    if (!original) return { ok: false, error: "unknown_message" };
    if (
      !original.replayId ||
      original.decryptFailed ||
      original.direction !== "out" ||
      original.replayAuthor !== this.userId ||
      peerId === this.userId
    )
      return { ok: false, error: "not_deletable" };
    if (original.status === "sending")
      return { ok: false, error: "message_pending" };
    if (this.deleteStates.get(editKey(peerId, this.userId, targetId))?.request)
      return { ok: false, error: "already_requested" };
    let recipientEncryptionPublicKey: Uint8Array;
    try {
      recipientEncryptionPublicKey = await this.getVerifiedPeerKey(peerId);
    } catch (error) {
      return { ok: false, error: this.peerKeyError(error) };
    }
    const sentAt = (this.deps.now ?? Date.now)();
    const clientMsgId = (this.deps.makeClientMsgId ?? newClientMsgId)();
    const frame: OutgoingFrame = {
      type: "send",
      clientMsgId,
      to: peerId,
      ciphertext: encryptDeleteRequestMessage({
        senderEncryptionPrivateKey: this.keys.encryption.privateKey,
        recipientEncryptionPublicKey,
        senderId: this.userId,
        recipientId: peerId,
        target: targetId,
        sentAt,
      }),
      senderCopy: encryptHistoryDeleteRequestEntry({
        historyKey: this.keys.historyKey,
        clientMsgId,
        peerId,
        senderId: this.userId,
        target: targetId,
        sentAt,
      }),
    };
    try {
      await (this.deps.outbox ?? indexedDbOutbox).put(this.userId, frame);
    } catch {
      return { ok: false, error: "server_unavailable" };
    }
    this.applyDeleteRequest({ peerId, author: this.userId, targetId });
    this.update({ error: "" });
    try {
      this.connection.send(frame);
    } catch {
      this.setError("server_unavailable");
    }
    return { ok: true };
  }

  /**
   * Answers a peer's delete request: `accept` hides the original at its author
   * and in this chat. The answer is applied locally as soon as it is queued.
   */
  async sendDeleteAnswer(
    peerId: string,
    targetId: string,
    accept: boolean,
  ): Promise<SendDeleteResult> {
    const original = this.state.chats
      .find((chat) => chat.peerId === peerId)
      ?.messages.find((message) => message.replayId === targetId);
    if (!original) return { ok: false, error: "unknown_message" };
    if (
      !original.replayId ||
      original.decryptFailed ||
      original.direction !== "in" ||
      original.replayAuthor !== peerId ||
      peerId === this.userId
    )
      return { ok: false, error: "not_deletable" };
    const state = this.deleteStates.get(editKey(peerId, peerId, targetId));
    if (!state?.request) return { ok: false, error: "no_request" };
    if (state.answer) return { ok: false, error: "already_answered" };
    let recipientEncryptionPublicKey: Uint8Array;
    try {
      recipientEncryptionPublicKey = await this.getVerifiedPeerKey(peerId);
    } catch (error) {
      return { ok: false, error: this.peerKeyError(error) };
    }
    const sentAt = (this.deps.now ?? Date.now)();
    const clientMsgId = (this.deps.makeClientMsgId ?? newClientMsgId)();
    const frame: OutgoingFrame = {
      type: "send",
      clientMsgId,
      to: peerId,
      ciphertext: encryptDeleteAnswerMessage({
        senderEncryptionPrivateKey: this.keys.encryption.privateKey,
        recipientEncryptionPublicKey,
        senderId: this.userId,
        recipientId: peerId,
        target: targetId,
        accept,
        sentAt,
      }),
      senderCopy: encryptHistoryDeleteAnswerEntry({
        historyKey: this.keys.historyKey,
        clientMsgId,
        peerId,
        senderId: this.userId,
        target: targetId,
        accept,
        sentAt,
      }),
    };
    try {
      await (this.deps.outbox ?? indexedDbOutbox).put(this.userId, frame);
    } catch {
      return { ok: false, error: "server_unavailable" };
    }
    this.applyDeleteAnswer({
      peerId,
      author: this.userId,
      originalAuthor: peerId,
      targetId,
      accept,
    });
    this.update({ error: "" });
    try {
      this.connection.send(frame);
    } catch {
      this.setError("server_unavailable");
    }
    return { ok: true };
  }

  /**
   * The new content of a row is encrypted exactly like its history copy: the
   * author's devices open the sender copy with the history key, the recipient
   * opens the ciphertext with the key of the peer.
   */
  private async decryptUpdatedRow(input: {
    peerId: string;
    direction: "in" | "out";
    clientMsgId: string;
    payload: string;
  }): Promise<DecryptedMessage> {
    if (input.direction === "out")
      return decryptHistoryEntry({
        historyKey: this.keys.historyKey,
        clientMsgId: input.clientMsgId,
        peerId: input.peerId,
        senderId: this.userId,
        entry: input.payload,
      });
    const senderEncryptionPublicKey =
      input.peerId === this.userId
        ? this.keys.encryption.publicKey
        : await this.getVerifiedPeerKey(input.peerId);
    return decryptTextMessage({
      recipientEncryptionPrivateKey: this.keys.encryption.privateKey,
      senderEncryptionPublicKey,
      senderId: input.peerId,
      recipientId: this.userId,
      ciphertext: input.payload,
    });
  }

  /**
   * Applies a changed row when it really belongs to the message that is already
   * in memory: the same row ID and direction, a text payload whose inner ID is
   * the known one and a revision that is not older. Returns true when the row
   * was found and the payload was authentic, so the caller may trust the change
   * number of the frame or of the page.
   */
  private async acceptUpdatedRow(input: {
    peerId: string;
    direction: "in" | "out";
    rowId: string;
    clientMsgId?: string;
    payload: string;
  }): Promise<boolean> {
    const chat = this.state.chats.find((item) => item.peerId === input.peerId);
    const message = chat?.messages.find(
      (item) => item.id === input.rowId && item.direction === input.direction,
    );
    if (!message) return false;
    /* The sender copy needs the client message ID of the row itself. */
    const clientMsgId = input.clientMsgId || message.clientMsgId;
    if (input.direction === "out" && !clientMsgId) return false;
    let decrypted: DecryptedMessage;
    try {
      decrypted = await this.decryptUpdatedRow({
        peerId: input.peerId,
        direction: input.direction,
        clientMsgId: clientMsgId ?? "",
        payload: input.payload,
      });
    } catch {
      return false;
    }
    if (decrypted.type !== "text") return false;
    if (!message.replayId || decrypted.id !== message.replayId) return false;
    const rev = decrypted.rev ?? 0;
    const current = message.rev ?? 0;
    if (rev < current) return false;
    if (rev > current)
      this.applyInPlaceText(
        input.peerId,
        message.id,
        input.direction,
        decrypted.text ?? "",
        rev,
      );
    return true;
  }

  /**
   * Replaces the text of one row in place. Its time, server sequence, status and
   * position stay, so the chat is neither reordered nor counted as unread. The
   * stored delete states are re-applied because they own the hidden text.
   */
  private applyInPlaceText(
    peerId: string,
    rowId: string,
    direction: "in" | "out",
    text: string,
    rev: number,
  ): void {
    const chat = this.state.chats.find((item) => item.peerId === peerId);
    if (!chat) return;
    const index = chat.messages.findIndex(
      (message) => message.id === rowId && message.direction === direction,
    );
    if (index < 0) return;
    const messages = chat.messages.slice();
    messages[index] = { ...chat.messages[index]!, text, rev, edited: true };
    const next = this.applyStoredEdits(peerId, messages);
    this.update({
      chats: this.state.chats.map((item) =>
        item.peerId === peerId ? { ...item, messages: next } : item,
      ),
    });
  }

  /**
   * A delete request is accepted only from the original author and only once
   * per original; it never becomes a bubble, an unread count or a reorder.
   */
  private applyDeleteRequest(input: IncomingDeleteRequest): void {
    /* Saved messages have no peer to ask, so nothing is tracked there. */
    if (input.peerId === this.userId) return;
    if (!this.registerDeleteRequest(input)) return;
    this.refreshStoredState(input.peerId, input.targetId);
  }

  /**
   * An answer counts only when it comes from the peer of the original author.
   * It is stored even before its request is known, but acts after the request.
   */
  private applyDeleteAnswer(input: IncomingDeleteAnswer): void {
    if (input.peerId === this.userId) return;
    if (input.author === input.originalAuthor) return;
    if (!this.registerDeleteAnswer(input)) return;
    this.refreshStoredState(input.peerId, input.targetId);
  }

  /** One request per original; a lower server seq wins when both are known. */
  private registerDeleteRequest(input: IncomingDeleteRequest): boolean {
    const key = editKey(input.peerId, input.author, input.targetId);
    const current = this.deleteStates.get(key);
    if (
      current?.request &&
      (!input.seq ||
        !current.request.seq ||
        BigInt(input.seq) >= BigInt(current.request.seq))
    )
      return false;
    this.deleteStates.set(key, {
      ...current,
      request: input.seq ? { seq: input.seq } : {},
    });
    return true;
  }

  /** The first answer is final; a lower server seq wins when both are known. */
  private registerDeleteAnswer(input: IncomingDeleteAnswer): boolean {
    const key = editKey(input.peerId, input.originalAuthor, input.targetId);
    const current = this.deleteStates.get(key);
    if (
      current?.answer &&
      (!input.seq ||
        !current.answer.seq ||
        BigInt(input.seq) >= BigInt(current.answer.seq))
    )
      return false;
    this.deleteStates.set(key, {
      ...current,
      answer: {
        accept: input.accept,
        ...(input.seq ? { seq: input.seq } : {}),
      },
    });
    return true;
  }

  /** Re-applies delete states to a chat that already holds the row. */
  private refreshStoredState(peerId: string, targetId: string): void {
    const chat = this.state.chats.find((item) => item.peerId === peerId);
    if (!chat?.messages.some((message) => message.replayId === targetId))
      return;
    const messages = this.applyStoredEdits(peerId, chat.messages);
    if (messages === chat.messages) return;
    this.update({
      chats: this.state.chats.map((item) =>
        item.peerId === peerId ? { ...item, messages } : item,
      ),
    });
  }

  private applyStoredEdit(peerId: string, message: ChatMessage): ChatMessage {
    if (!message.replayId || !message.replayAuthor || message.decryptFailed)
      return message;
    const key = editKey(peerId, message.replayAuthor, message.replayId);
    let result = message;
    /* A request without an effective answer leaves the original untouched. */
    const deletion = deletionStatus(this.deleteStates.get(key));
    if (result.deletion !== deletion) {
      const next: ChatMessage = { ...result };
      if (deletion === undefined) delete next.deletion;
      else next.deletion = deletion;
      result = next;
    }
    /* The peer hid the text: keep it out of memory and drop late edits. */
    if (result.deletion !== "accepted" || result.direction !== "in")
      return result;
    if (result.text === "" && result.edited === undefined) return result;
    const cleared: ChatMessage = { ...result, text: "" };
    delete cleared.edited;
    return cleared;
  }

  private applyStoredEdits(
    peerId: string,
    messages: ChatMessage[],
  ): ChatMessage[] {
    let changed = false;
    const result = messages.map((message) => {
      const next = this.applyStoredEdit(peerId, message);
      if (next !== message) changed = true;
      return next;
    });
    return changed ? result : messages;
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
      frame.type === "message_updated" &&
      typeof frame.id === "string" &&
      typeof frame.from === "string" &&
      typeof frame.to === "string" &&
      typeof frame.seq === "string" &&
      typeof frame.changeSeq === "string" &&
      typeof frame.payload === "string"
    ) {
      /* The payload is either the ciphertext for the peer or the sender copy. */
      const fromAuthor = frame.from === this.userId;
      const peerId = fromAuthor
        ? frame.to
        : frame.to === this.userId
          ? frame.from
          : "";
      if (!peerId) return;
      const direction = fromAuthor ? "out" : "in";
      const clearedBeforeSeq = this.clearedBeforeSeqs.get(peerId);
      if (
        /^\d+$/u.test(frame.seq) &&
        clearedBeforeSeq &&
        BigInt(frame.seq) <= BigInt(clearedBeforeSeq)
      )
        return;
      const accepted = await this.acceptUpdatedRow({
        peerId,
        direction,
        rowId: frame.id,
        payload: frame.payload,
      });
      if (accepted) this.raiseKnownChangeSeq(peerId, frame.changeSeq);
      return;
    }
    if (
      frame.type === "message" &&
      typeof frame.id === "string" &&
      typeof frame.from === "string" &&
      typeof frame.ciphertext === "string" &&
      typeof frame.createdAt === "string"
    ) {
      /* An erased row has an empty payload; its placeholder is a later task. */
      if (frame.deleted === true) return;
      const clearedBeforeSeq = this.clearedBeforeSeqs.get(frame.from);
      if (
        typeof frame.seq === "string" &&
        /^\d+$/u.test(frame.seq) &&
        clearedBeforeSeq &&
        BigInt(frame.seq) <= BigInt(clearedBeforeSeq)
      )
        return;
      let text = "";
      let replayId: string | undefined;
      let sentAt: number | undefined;
      let rev: number | undefined;
      let decryptFailed = false;
      /* A note to yourself is encrypted with your own public key. */
      const isSavedMessage = frame.from === this.userId;
      try {
        const senderEncryptionPublicKey = isSavedMessage
          ? this.keys.encryption.publicKey
          : await this.getVerifiedPeerKey(frame.from);
        const decrypted = decryptTextMessage({
          recipientEncryptionPrivateKey: this.keys.encryption.privateKey,
          senderEncryptionPublicKey,
          senderId: frame.from,
          recipientId: this.userId,
          ciphertext: frame.ciphertext,
        });
        if (decrypted.type === "delete_request") {
          /* A request is never a message either. */
          if (decrypted.target)
            this.applyDeleteRequest({
              peerId: frame.from,
              author: frame.from,
              targetId: decrypted.target,
              ...(typeof frame.seq === "string" && /^\d+$/u.test(frame.seq)
                ? { seq: frame.seq }
                : {}),
            });
          return;
        }
        if (decrypted.type === "delete_answer") {
          if (decrypted.target && typeof decrypted.accept === "boolean")
            this.applyDeleteAnswer({
              peerId: frame.from,
              author: frame.from,
              originalAuthor: this.userId,
              targetId: decrypted.target,
              accept: decrypted.accept,
              ...(typeof frame.seq === "string" && /^\d+$/u.test(frame.seq)
                ? { seq: frame.seq }
                : {}),
            });
          return;
        }
        if (decrypted.type && decrypted.type !== "text") return;
        text = decrypted.text ?? "";
        replayId = decrypted.id;
        sentAt = decrypted.sentAt;
        rev = decrypted.rev;
      } catch {
        if (isV2Envelope(frame.ciphertext)) return;
        /* Render a safe placeholder; WebSocket still acks this frame. */
        decryptFailed = true;
      }
      const message: ChatMessage = this.applyStoredEdit(frame.from, {
        id: frame.id,
        ...(replayId ? { replayId, replayAuthor: frame.from } : {}),
        text,
        createdAt:
          sentAt !== undefined
            ? new Date(sentAt).toISOString()
            : frame.createdAt,
        direction: isSavedMessage ? "out" : "in",
        ...(typeof frame.seq === "string" && /^\d+$/u.test(frame.seq)
          ? { seq: frame.seq }
          : {}),
        ...plainEditFields({ rev, sentAt }),
        ...(decryptFailed ? { decryptFailed: true } : {}),
        arrivalOrder: this.arrivalOrder++,
      });
      const existing = this.state.chats.find(
        (chat) => chat.peerId === frame.from,
      );
      const chat: Chat = existing ?? {
        peerId: frame.from,
        messages: [],
        unreadCount: 0,
      };
      const duplicate = replayId
        ? chat.messages.find(
            (item) =>
              item.direction === message.direction &&
              item.replayId === replayId &&
              item.replayAuthor === frame.from,
          )
        : undefined;
      if (duplicate) {
        this.upsertMessage(frame.from, {
          ...message,
          countedUnread: duplicate.countedUnread,
        });
        return;
      }
      const countedUnread =
        !isSavedMessage && this.state.activePeer !== frame.from;
      const unreadCount = countedUnread ? chat.unreadCount + 1 : 0;
      this.upsertMessage(
        frame.from,
        countedUnread ? { ...message, countedUnread: true } : message,
        unreadCount,
      );
      if (!isSavedMessage && this.state.activePeer === frame.from)
        this.scheduleRead(frame.from);
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
    /* Your own notes never need a read marker. */
    if (peerId === this.userId) return;
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
          messages: this.applyStoredEdits(
            peerId,
            mergeMessages(chat.messages, [message]),
          ),
        }
      : {
          peerId,
          unreadCount: unreadCount ?? 0,
          messages: this.applyStoredEdits(peerId, [message]),
        };
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
        .filter((peerId) => peerId !== this.userId)
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
export const MAX_MESSAGE_CHARS = 4000;
/** Reserve of change numbers read again on the first catch-up request. */
const CHANGE_CATCHUP_RESERVE = 100n;

/** One request and at most one answer per (chat, original author, target). */
type DeleteState = {
  request?: { seq?: string };
  answer?: { accept: boolean; seq?: string };
};

type IncomingDeleteRequest = {
  peerId: string;
  author: string;
  targetId: string;
  seq?: string;
};

type IncomingDeleteAnswer = {
  peerId: string;
  author: string;
  originalAuthor: string;
  targetId: string;
  accept: boolean;
  seq?: string;
};

/** A delete state belongs to one chat, one author and one original message ID. */
function editKey(peerId: string, author: string, targetId: string): string {
  return `${peerId}\n${author}\n${targetId}`;
}

/**
 * A request without an effective answer is pending. An answer that is not
 * newer than the request in the server sequence does not act.
 */
function deletionStatus(
  state: DeleteState | undefined,
): DeletionStatus | undefined {
  if (!state?.request) return undefined;
  const answer = state.answer;
  if (
    !answer ||
    (answer.seq &&
      state.request.seq &&
      BigInt(answer.seq) <= BigInt(state.request.seq))
  )
    return "pending";
  return answer.accept ? "accepted" : "declined";
}

export function unreadAfterHistoryMerge(
  chat: Chat,
  historyMessages: ChatMessage[],
): { unreadCount: number; messages: ChatMessage[] } {
  const compensated = new Set<string>();
  const messages = chat.messages.map((existing) => {
    if (
      existing.direction !== "in" ||
      !existing.countedUnread ||
      !existing.replayId ||
      !historyMessages.some(
        (message) =>
          message.direction === "in" &&
          message.replayId === existing.replayId &&
          message.replayAuthor === existing.replayAuthor,
      )
    )
      return existing;
    compensated.add(`${existing.replayAuthor}\n${existing.replayId}`);
    return { ...existing, countedUnread: false };
  });
  return {
    unreadCount: Math.max(0, chat.unreadCount - compensated.size),
    messages,
  };
}

/** Revision fields a decrypted text row adds to its chat message. */
function plainEditFields(decrypted: Pick<DecryptedMessage, "rev" | "sentAt">): {
  rev: number;
  sentAt?: number;
  edited?: boolean;
} {
  const rev = decrypted.rev ?? 0;
  return {
    rev,
    ...(rev > 0 ? { edited: true } : {}),
    ...(decrypted.sentAt !== undefined ? { sentAt: decrypted.sentAt } : {}),
  };
}

/** Why PUT /messages/:id failed: a deleted row, a foreign row, no connection. */
function editRequestError(error: unknown): SendEditError {
  if (error instanceof ApiError) {
    if (error.status === 409) return "message_deleted";
    if (error.status === 404) return "unknown_message";
    if (error.status === 0 || error.code === "network_timeout")
      return "server_unavailable";
    if (error.status >= 500) return "server_unavailable";
    return "send_failed";
  }
  if (error instanceof TypeError) return "server_unavailable";
  return "send_failed";
}

function isV2Envelope(value: string): boolean {
  try {
    return base64ToBytes(value)[0] === 2;
  } catch {
    return false;
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
        (item.id === message.id &&
          (!(item.replayId && message.replayId) ||
            item.replayAuthor === message.replayAuthor)) ||
        (!!item.replayId &&
          item.replayId === message.replayId &&
          item.replayAuthor === message.replayAuthor) ||
        (!!item.clientMsgId && item.clientMsgId === message.clientMsgId),
    );
    if (index < 0) result.push(message);
    else {
      const previous = result[index]!;
      /* A newer revision always wins, so reloading a page cannot roll an edit back. */
      const previousRev = previous.rev ?? 0;
      const incomingRev = message.rev ?? 0;
      const keepPrevious =
        previousRev !== incomingRev
          ? previousRev > incomingRev
          : !!previous.seq &&
            !!message.seq &&
            BigInt(previous.seq) <= BigInt(message.seq);
      const first = keepPrevious ? message : previous;
      const chosen = keepPrevious ? previous : message;
      result[index] = {
        ...first,
        ...chosen,
        status: mergeStatus(previous.status, message.status),
        frame: message.frame ?? previous.frame,
        countedUnread: previous.countedUnread || message.countedUnread,
      };
    }
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
