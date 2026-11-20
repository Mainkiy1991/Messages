import {
  bytesToHex,
  hexToBytes,
  signAuth,
  signKeyBinding,
  userIdFromPublicKey,
  verifyKeyBinding,
  generateDeviceKeys,
  deviceIdFromPublicKey,
  signDeviceRegistration,
  signDeviceAuth,
  encryptDeviceLabel,
  type DerivedKeys,
} from "@messages/crypto";
import {
  saveServerSession,
  isDeviceKeys,
  type AccountKeys,
  type DeviceKeys,
  type ServerSession,
} from "../session.js";
import { detectDeviceLabel } from "./device-label.js";

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
  cleared?: boolean;
};
export type ConversationClear = {
  peerId: string;
  clearedBeforeSeq: string;
  hidden?: boolean;
};
export type ConversationErase = {
  erased: number;
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
export type DeviceRow = {
  deviceId: string;
  labelCiphertext: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
};
export type DevicesResponse = { devices: DeviceRow[] };
export type RevokeOthersResponse = {
  revoked: number;
  endedLegacySessions: number;
};
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

export class DeviceRevokedError extends Error {
  constructor() {
    super("device_revoked");
    this.name = "DeviceRevokedError";
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

export async function registerDevice(
  derived: DerivedKeys,
  fetcher: FetchLike = fetch,
): Promise<{ session: ServerSession; deviceKeys: DeviceKeys }> {
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
  const device = generateDeviceKeys();
  const deviceId = deviceIdFromPublicKey(device.publicKey);
  const identityPublicKey = bytesToHex(derived.identity.publicKey);
  const encryptionPublicKey = bytesToHex(derived.encryption.publicKey);
  const historyKey = derived.historyKey;
  const label = detectDeviceLabel(
    typeof navigator === "undefined" ? "" : navigator.userAgent,
  );
  const deviceKeys: DeviceKeys = {
    identityPublicKey: derived.identity.publicKey,
    encryption: {
      privateKey: derived.encryption.privateKey,
      publicKey: derived.encryption.publicKey,
    },
    historyKey,
    device,
  };
  const result = await request<ServerSession>(
    fetcher,
    "/auth/device/register",
    undefined,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        identityPublicKey,
        encryptionPublicKey,
        keyBindingSignature: bytesToHex(
          signKeyBinding(
            derived.identity.privateKey,
            derived.encryption.publicKey,
          ),
        ),
        devicePublicKey: bytesToHex(device.publicKey),
        deviceLabel: encryptDeviceLabel({
          historyKey,
          deviceId,
          browser: label.browser,
          os: label.os,
        }),
        signature: bytesToHex(
          signDeviceRegistration(
            derived.identity.privateKey,
            challenge.challengeId,
            challenge.challenge,
            device.publicKey,
          ),
        ),
      }),
    },
  );
  const expectedUserId = userIdFromPublicKey(derived.identity.publicKey);
  if (result.userId !== expectedUserId || result.deviceId !== deviceId)
    throw new Error("Server returned unexpected registration data");
  return { session: { ...result, deviceId }, deviceKeys };
}

export async function deviceLogin(
  keys: DeviceKeys,
  fetcher: FetchLike = fetch,
): Promise<ServerSession> {
  const attempt = async (): Promise<ServerSession> => {
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
    try {
      const result = await request<ServerSession & { deviceId?: string }>(
        fetcher,
        "/auth/device/login",
        undefined,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            challengeId: challenge.challengeId,
            deviceId: deviceIdFromPublicKey(keys.device.publicKey),
            signature: bytesToHex(
              signDeviceAuth(
                keys.device.privateKey,
                challenge.challengeId,
                challenge.challenge,
              ),
            ),
          }),
        },
      );
      if (
        result.userId !== userIdFromPublicKey(keys.identityPublicKey) ||
        result.deviceId !== deviceIdFromPublicKey(keys.device.publicKey)
      )
        throw new Error("Server returned unexpected device login data");
      await saveServerSession(result, keys);
      return result;
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 403 &&
        error.code === "device_revoked"
      )
        throw new DeviceRevokedError();
      throw error;
    }
  };

  try {
    return await attempt();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      try {
        return await attempt();
      } catch (secondError) {
        if (
          secondError instanceof ApiError &&
          (secondError.status === 401 ||
            (secondError.status === 403 &&
              secondError.code === "device_revoked"))
        )
          throw new DeviceRevokedError();
        throw secondError;
      }
    }
    throw error;
  }
}

export async function loginWithKeys(
  keys: AccountKeys,
  fetcher: FetchLike = fetch,
): Promise<ServerSession> {
  if (isDeviceKeys(keys)) return deviceLogin(keys, fetcher);
  return loginToServer(keys, fetcher);
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

export function getDevices(token: string, fetcher: FetchLike = fetch) {
  return request<DevicesResponse>(fetcher, "/devices", token);
}

export function revokeDevice(
  deviceId: string,
  token: string,
  fetcher: FetchLike = fetch,
) {
  return request<void>(
    fetcher,
    `/devices/${encodeURIComponent(deviceId)}`,
    token,
    {
      method: "DELETE",
    },
  );
}

export function revokeOtherDevices(token: string, fetcher: FetchLike = fetch) {
  return request<RevokeOthersResponse>(
    fetcher,
    "/devices/revoke-others",
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
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

export function eraseConversation(
  peerId: string,
  token: string,
  fetcher: FetchLike = fetch,
) {
  return request<ConversationErase>(
    fetcher,
    `/conversations/${peerId}/erase`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
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
