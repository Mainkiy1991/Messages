import {
  bytesToBase64,
  base64ToBytes,
  unwrapServerSession,
  unwrapSecrets,
  wrapServerSession,
  wrapSecrets,
  type DerivedKeys,
  type WrappedServerSession,
  type WrappedSecrets,
} from "@messages/crypto";
import { indexedDbOutbox } from "./lib/outbox.js";

const DB_NAME = "messages-session";
const STORE_NAME = "keys";
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function getValue<T>(key: string): Promise<T | undefined> {
  const db = await openDatabase();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const request = db
        .transaction(STORE_NAME)
        .objectStore(STORE_NAME)
        .get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
async function putValues(
  values: Array<[string, unknown]>,
  deletes: string[] = [],
): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      for (const [key, value] of values) store.put(value, key);
      for (const key of deletes) store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
function packKeys(keys: DerivedKeys): Uint8Array {
  const pair = (p: { privateKey: Uint8Array; publicKey: Uint8Array }) => ({
    privateKey: bytesToBase64(p.privateKey),
    publicKey: bytesToBase64(p.publicKey),
  });
  return new TextEncoder().encode(
    JSON.stringify({
      identity: pair(keys.identity),
      encryption: pair(keys.encryption),
      historyKey: bytesToBase64(keys.historyKey),
    }),
  );
}
function unpackKeys(bytes: Uint8Array): DerivedKeys {
  const raw = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  const pair = (p: { privateKey: string; publicKey: string }) => ({
    privateKey: base64ToBytes(p.privateKey),
    publicKey: base64ToBytes(p.publicKey),
  });
  const keys = {
    identity: pair(raw.identity),
    encryption: pair(raw.encryption),
    historyKey: base64ToBytes(raw.historyKey),
  };
  if (
    [
      keys.identity.privateKey,
      keys.identity.publicKey,
      keys.encryption.privateKey,
      keys.encryption.publicKey,
      keys.historyKey,
    ].some((v) => v.length !== 32)
  )
    throw new Error("Invalid secret data");
  return keys;
}

export type ServerSession = {
  token: string;
  expiresAt: string;
  userId: string;
};
type StoredServerSession = ServerSession | WrappedServerSession;
export type PinState = {
  blob: WrappedSecrets;
  failedAttempts: number;
  nextAttemptAt: number;
};

function isWrappedServerSession(value: unknown): value is WrappedServerSession {
  return (
    typeof value === "object" &&
    value !== null &&
    "v" in value &&
    value.v === 1 &&
    "nonce" in value &&
    typeof value.nonce === "string" &&
    "ciphertext" in value &&
    typeof value.ciphertext === "string"
  );
}

function parseServerSession(value: unknown): ServerSession {
  if (
    !value ||
    typeof value !== "object" ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    !("expiresAt" in value) ||
    typeof value.expiresAt !== "string" ||
    !("userId" in value) ||
    typeof value.userId !== "string"
  )
    throw new Error("SERVER_SESSION_INVALID");
  return {
    token: value.token,
    expiresAt: value.expiresAt,
    userId: value.userId,
  };
}

function packServerSession(session: ServerSession): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(session));
}

function unpackServerSession(bytes: Uint8Array): ServerSession {
  return parseServerSession(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}

export function pinDelayForAttempt(failedAttempts: number): number {
  if (failedAttempts < 5) return 0;
  if (failedAttempts === 5) return 5 * 60_000;
  if (failedAttempts === 6) return 15 * 60_000;
  return 60 * 60_000;
}
export function pinFailureState(
  failedAttempts: number,
  now: number,
): Pick<PinState, "failedAttempts" | "nextAttemptAt"> {
  const delay = pinDelayForAttempt(failedAttempts);
  return {
    failedAttempts,
    nextAttemptAt: delay ? now + delay : 0,
  };
}
export async function saveSession(keys: DerivedKeys): Promise<void> {
  await putValues([["derivedKeys", keys]]);
}
export async function saveServerSession(
  session: ServerSession,
  keys: DerivedKeys,
): Promise<void> {
  const pinState = await getValue<PinState>("pinState");
  if (!pinState) {
    await putValues([["serverSession", session]]);
    return;
  }
  const sessionBytes = packServerSession(session);
  try {
    const encrypted = wrapServerSession(sessionBytes, keys.identity.privateKey);
    await putValues([["serverSession", encrypted]]);
  } finally {
    sessionBytes.fill(0);
  }
}
export async function restoreServerSession(
  keys: DerivedKeys,
): Promise<ServerSession | null> {
  const stored = await getValue<StoredServerSession>("serverSession");
  if (!stored) return null;
  const pinState = await getValue<PinState>("pinState");
  if (pinState) {
    if (!isWrappedServerSession(stored)) {
      await putValues([], ["serverSession"]);
      return null;
    }
    const bytes = unwrapServerSession(stored, keys.identity.privateKey);
    try {
      return unpackServerSession(bytes);
    } finally {
      bytes.fill(0);
    }
  }
  if (isWrappedServerSession(stored))
    throw new Error("Encrypted server session exists without PIN");
  return parseServerSession(stored);
}
export async function getPinState(): Promise<PinState | null> {
  const pinState = (await getValue<PinState>("pinState")) ?? null;
  if (pinState) {
    const serverSession = await getValue<unknown>("serverSession");
    if (serverSession && !isWrappedServerSession(serverSession))
      await putValues([], ["serverSession"]);
  }
  return pinState;
}
export async function restoreSession(): Promise<DerivedKeys | null> {
  if (await getPinState()) return null;
  return (await getValue<DerivedKeys>("derivedKeys")) ?? null;
}
export async function enablePin(keys: DerivedKeys, pin: string): Promise<void> {
  const secretBytes = packKeys(keys);
  let blob: WrappedSecrets;
  try {
    blob = await wrapSecrets(secretBytes, pin);
  } finally {
    secretBytes.fill(0);
  }
  const values: Array<[string, unknown]> = [
    [
      "pinState",
      { blob, failedAttempts: 0, nextAttemptAt: 0 } satisfies PinState,
    ],
  ];
  const currentSession = await getValue<unknown>("serverSession");
  if (currentSession && !isWrappedServerSession(currentSession)) {
    const sessionBytes = packServerSession(parseServerSession(currentSession));
    try {
      values.push([
        "serverSession",
        wrapServerSession(sessionBytes, keys.identity.privateKey),
      ]);
    } finally {
      sessionBytes.fill(0);
    }
  }
  await indexedDbOutbox.clear();
  await putValues(values, ["derivedKeys"]);
}
export async function unlockWithPin(pin: string): Promise<DerivedKeys> {
  const state = await getPinState();
  if (!state) throw new Error("PIN is not enabled");
  if (Date.now() < state.nextAttemptAt) throw new Error("PIN_ATTEMPT_DELAY");
  let keys: DerivedKeys;
  try {
    const secretBytes = await unwrapSecrets(state.blob, pin);
    try {
      keys = unpackKeys(secretBytes);
    } finally {
      secretBytes.fill(0);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "PIN_KDF_FAILED")
      throw error;
    const failedAttempts = state.failedAttempts + 1;
    const failure = pinFailureState(failedAttempts, Date.now());
    await putValues([
      [
        "pinState",
        {
          ...state,
          ...failure,
        },
      ],
    ]);
    throw new Error("PIN_INVALID");
  }
  await putValues([
    ["pinState", { ...state, failedAttempts: 0, nextAttemptAt: 0 }],
  ]);
  return keys;
}
export async function changePin(
  keys: DerivedKeys,
  oldPin: string,
  newPin: string,
): Promise<void> {
  const old = await unlockWithPin(oldPin);
  if (JSON.stringify(packKeys(old)) !== JSON.stringify(packKeys(keys)))
    throw new Error("PIN_INVALID");
  const secretBytes = packKeys(keys);
  let blob: WrappedSecrets;
  try {
    blob = await wrapSecrets(secretBytes, newPin);
  } finally {
    secretBytes.fill(0);
  }
  await putValues([
    [
      "pinState",
      { blob, failedAttempts: 0, nextAttemptAt: 0 } satisfies PinState,
    ],
  ]);
}
export async function disablePin(pin: string): Promise<DerivedKeys> {
  const keys = await unlockWithPin(pin);
  const storedSession = await getValue<unknown>("serverSession");
  const values: Array<[string, unknown]> = [["derivedKeys", keys]];
  if (isWrappedServerSession(storedSession)) {
    const bytes = unwrapServerSession(storedSession, keys.identity.privateKey);
    try {
      values.push(["serverSession", unpackServerSession(bytes)]);
    } finally {
      bytes.fill(0);
    }
  }
  await putValues(values, ["pinState"]);
  return keys;
}
export async function clearSession(): Promise<void> {
  await indexedDbOutbox.clear();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Session database is still open"));
  });
}
