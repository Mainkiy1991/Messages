import {
  bytesToHex,
  hexToBytes,
  signAuth,
  signKeyBinding,
  userIdFromPublicKey,
  verifyKeyBinding,
  type DerivedKeys,
} from "@messages/crypto";
import { saveServerSession, type ServerSession } from "../session.js";

export type FetchLike = typeof fetch;
export type UserKeys = {
  userId: string;
  encryptionPublicKey: string;
  keyBindingSignature: string;
};
export type ConversationSummary = {
  peerId: string;
  lastSeq: string;
  lastCreatedAt: string;
  /** Highest change number of the chat; absent means the server sent none. */
  lastChangeSeq?: string;
};
export type ConversationClear = {
  peerId: string;
  clearedBeforeSeq: string;
};
export type HistoryMessage = {
  id: string;
  seq: string;
  direction: "in" | "out";
  clientMsgId: string;
  payload: string;
  createdAt: string;
  deliveredAt: string | null;
  /** Set when the row was erased or edited; absent in older responses. */
  changeSeq?: string | null;
  /** The row was erased: its payload is empty. */
  deleted?: boolean;
};
export type ContactBookResponse = { version: string; blob: string | null };
export function resolveApiUrl(
  value?: string,
  fallback = import.meta.env.DEV ? "http://localhost:3000" : "",
): string {
  return (value || fallback).replace(/\/$/u, "");
}

export const API_URL = resolveApiUrl(
  import.meta.env.VITE_API_URL,
  import.meta.env.DEV ? "http://localhost:3000" : "",
);

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public data?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

async function request<T>(
  fetcher: FetchLike,
  path: string,
  token?: string,
  init?: RequestInit,
): Promise<T> {
  const controller = new AbortController();
  const setTimer = globalThis.setTimeout;
  const clearTimer = globalThis.clearTimeout;
  let timedOut = false;
  const timer = setTimer(() => {
    timedOut = true;
    controller.abort();
  }, 10_000);
  try {
    const response = await fetcher(`${API_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init?.headers ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) {
      let code = "request_error";
      let data: Record<string, unknown> | undefined;
      try {
        data = (await response.json()) as Record<string, unknown>;
        code = (data.error as string | undefined) ?? code;
      } catch {
        /* Empty response */
      }
      throw new ApiError(response.status, code, data);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } catch (error) {
    if (timedOut) throw new ApiError(0, "network_timeout");
    throw error;
  } finally {
    clearTimer(timer);
  }
}

export async function loginToServer(
  keys: DerivedKeys,
  fetcher: FetchLike = fetch,
): Promise<ServerSession> {
  const challenge = await request<{ challengeId: string; challenge: string }>(
    fetcher,
    "/auth/challenge",
    undefined,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  const identityPublicKey = bytesToHex(keys.identity.publicKey);
  const encryptionPublicKey = bytesToHex(keys.encryption.publicKey);
  const result = await request<ServerSession>(
    fetcher,
    "/auth/login",
    undefined,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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
      }),
    },
  );
  if (result.userId !== userIdFromPublicKey(keys.identity.publicKey))
    throw new Error("Server returned an unexpected user ID");
  await saveServerSession(result, keys);
  return result;
}

export async function getUserKeys(
  userId: string,
  token: string,
  fetcher: FetchLike = fetch,
): Promise<UserKeys> {
  return request<UserKeys>(fetcher, `/users/${userId}/keys`, token);
}

export async function logoutFromServer(
  token: string,
  fetcher: FetchLike = fetch,
): Promise<void> {
  await request<void>(fetcher, "/auth/logout", token, { method: "POST" });
}

export function getConversations(token: string, fetcher: FetchLike = fetch) {
  return request<{
    conversations: ConversationSummary[];
    cleared: ConversationClear[];
  }>(fetcher, "/conversations", token);
}

export function deleteConversation(
  peerId: string,
  token: string,
  fetcher: FetchLike = fetch,
) {
  return request<{ clearedBeforeSeq: string }>(
    fetcher,
    `/conversations/${peerId}`,
    token,
    { method: "DELETE" },
  );
}

export function getHistory(
  peerId: string,
  token: string,
  before?: string,
  fetcher: FetchLike = fetch,
) {
  const params = new URLSearchParams({ limit: "50" });
  if (before) params.set("before", before);
  return request<{
    messages: HistoryMessage[];
    hasMore: boolean;
    peerReadUpToSeq: string | null;
  }>(fetcher, `/history/${peerId}?${params}`, token);
}

export function getHistoryAfter(
  peerId: string,
  token: string,
  after: string,
  fetcher: FetchLike = fetch,
) {
  const params = new URLSearchParams({ limit: "50", after });
  return request<{
    messages: HistoryMessage[];
    hasMore: boolean;
    peerReadUpToSeq: string | null;
  }>(fetcher, `/history/${peerId}?${params}`, token);
}

/**
 * Replaces the content of your own message row. The body has exactly the two
 * ciphertexts the server stores, and a successful answer is an empty 204.
 */
export function updateMessage(
  id: string,
  ciphertext: string,
  senderCopy: string,
  token: string,
  fetcher: FetchLike = fetch,
) {
  return request<void>(fetcher, `/messages/${id}`, token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ciphertext, senderCopy }),
  });
}

/**
 * Erases your own row on the server: the ciphertext and the sender copy become
 * empty and the row is marked as deleted. There is no body and no Content-Type;
 * both the first request and a repeat answer with an empty 204.
 */
export function deleteMessage(
  id: string,
  token: string,
  fetcher: FetchLike = fetch,
) {
  return request<void>(fetcher, `/messages/${id}`, token, { method: "DELETE" });
}

/** Rows of one chat whose change number is above the known one. */
export function getHistoryChangedAfter(
  peerId: string,
  token: string,
  changedAfter: string,
  fetcher: FetchLike = fetch,
) {
  const params = new URLSearchParams({ limit: "100", changedAfter });
  return request<{
    messages: HistoryMessage[];
    hasMore: boolean;
    peerReadUpToSeq: string | null;
  }>(fetcher, `/history/${peerId}?${params}`, token);
}

export function getContacts(token: string, fetcher: FetchLike = fetch) {
  return request<ContactBookResponse>(fetcher, "/contacts", token);
}

export function putContacts(
  token: string,
  baseVersion: string,
  blob: string,
  fetcher: FetchLike = fetch,
) {
  return request<{ version: string }>(fetcher, "/contacts", token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseVersion, blob }),
  });
}

export function verifyUserKeys(peerId: string, value: UserKeys): Uint8Array {
  if (value.userId !== peerId) throw new Error("key_identity_mismatch");
  const identity = hexToBytes(peerId);
  const encryption = hexToBytes(value.encryptionPublicKey);
  const signature = hexToBytes(value.keyBindingSignature);
  if (
    identity.length !== 32 ||
    encryption.length !== 32 ||
    !verifyKeyBinding(identity, encryption, signature)
  ) {
    throw new Error("key_binding_invalid");
  }
  return encryption;
}
