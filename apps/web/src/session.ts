import {
  bytesToBase64,
  base64ToBytes,
  unwrapSecrets,
  wrapSecrets,
  type DerivedKeys,
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
export type PinState = {
  blob: WrappedSecrets;
  failedAttempts: number;
  nextAttemptAt: number;
};
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
export async function saveServerSession(session: ServerSession): Promise<void> {
  await putValues([["serverSession", session]]);
}
export async function restoreServerSession(): Promise<ServerSession | null> {
  return (await getValue<ServerSession>("serverSession")) ?? null;
}
export async function getPinState(): Promise<PinState | null> {
  return (await getValue<PinState>("pinState")) ?? null;
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
  await indexedDbOutbox.clear();
  await putValues(
    [
      [
        "pinState",
        { blob, failedAttempts: 0, nextAttemptAt: 0 } satisfies PinState,
      ],
    ],
    ["derivedKeys"],
  );
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
  } catch {
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
  await putValues([["derivedKeys", keys]], ["pinState"]);
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
