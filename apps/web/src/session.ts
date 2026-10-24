import type { DerivedKeys } from "@messages/crypto";

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

export async function saveSession(keys: DerivedKeys): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(keys, "derivedKeys");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

export type ServerSession = {
  token: string;
  expiresAt: string;
  userId: string;
};

export async function saveServerSession(session: ServerSession): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(session, "serverSession");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

export async function restoreServerSession(): Promise<ServerSession | null> {
  const db = await openDatabase();
  const value = await new Promise<ServerSession | undefined>(
    (resolve, reject) => {
      const request = db
        .transaction(STORE_NAME)
        .objectStore(STORE_NAME)
        .get("serverSession");
      request.onsuccess = () =>
        resolve(request.result as ServerSession | undefined);
      request.onerror = () => reject(request.error);
    },
  );
  db.close();
  return value ?? null;
}

export async function saveServerSessionValue(
  session: ServerSession,
): Promise<void> {
  await saveServerSession(session);
}

export async function restoreSession(): Promise<DerivedKeys | null> {
  const db = await openDatabase();
  const value = await new Promise<DerivedKeys | undefined>(
    (resolve, reject) => {
      const request = db
        .transaction(STORE_NAME)
        .objectStore(STORE_NAME)
        .get("derivedKeys");
      request.onsuccess = () =>
        resolve(request.result as DerivedKeys | undefined);
      request.onerror = () => reject(request.error);
    },
  );
  db.close();
  return value ?? null;
}

export async function clearSession(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Session database is still open"));
  });
}
