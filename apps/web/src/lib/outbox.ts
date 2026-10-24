import type { OutgoingFrame } from "./websocket.js";

const DB_NAME = "messages-outbox";
const STORE = "frames";
export interface OutboxStore {
  list(userId: string): Promise<OutgoingFrame[]>;
  put(userId: string, frame: OutgoingFrame): Promise<void>;
  remove(userId: string, clientMsgId: string): Promise<void>;
  clear(): Promise<void>;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(STORE, { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function transact<T>(
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const request = action(tx.objectStore(STORE));
        let result: T;
        request.onsuccess = () => {
          result = request.result;
        };
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => {
          db.close();
          resolve(result!);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}
const memory = new Map<string, OutgoingFrame>();
export const indexedDbOutbox: OutboxStore =
  typeof indexedDB === "undefined"
    ? {
        async list(userId) {
          return [...memory.entries()]
            .filter(([key]) => key.startsWith(`${userId}:`))
            .map(([, frame]) => frame);
        },
        async put(userId, frame) {
          memory.set(`${userId}:${frame.clientMsgId}`, frame);
        },
        async remove(userId, id) {
          memory.delete(`${userId}:${id}`);
        },
        async clear() {
          memory.clear();
        },
      }
    : {
        async list(userId) {
          const records = await transact<
            Array<{ key: string; userId: string; frame: OutgoingFrame }>
          >((store) => store.getAll());
          return records
            .filter((item) => item.userId === userId)
            .map((item) => item.frame);
        },
        async put(userId, frame) {
          await transact((store) =>
            store.put({ key: `${userId}:${frame.clientMsgId}`, userId, frame }),
          );
        },
        async remove(userId, clientMsgId) {
          await transact((store) => store.delete(`${userId}:${clientMsgId}`));
        },
        async clear() {
          await new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(DB_NAME);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          });
        },
      };
