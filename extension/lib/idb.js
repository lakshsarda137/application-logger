// Promise wrapper over IndexedDB. Shared by the service worker and the log
// dialog (both run on the extension's origin, so they see the same DB).

const DB_NAME = "application-logger";
const DB_VERSION = 2;

export const SESSIONS = "sessions"; // one per tab (plus tabs it opened)
export const PAGES = "pages"; // page snapshots
export const UPLOADS = "uploads"; // files, stored as Blobs
export const ANSWERS = "answers"; // form field answers

let dbPromise = null;

function upgrade(db) {
  // v1 only had a "pending" store for the phase 1 dialog; nothing in it is worth keeping.
  if (db.objectStoreNames.contains("pending")) db.deleteObjectStore("pending");

  if (!db.objectStoreNames.contains(SESSIONS)) {
    const s = db.createObjectStore(SESSIONS, { keyPath: "id" });
    s.createIndex("tabIds", "tabIds", { multiEntry: true });
    s.createIndex("lastActivity", "lastActivity");
  }
  if (!db.objectStoreNames.contains(PAGES)) {
    const s = db.createObjectStore(PAGES, { keyPath: "id", autoIncrement: true });
    s.createIndex("sessionId", "sessionId");
    s.createIndex("sessionUrl", ["sessionId", "url"], { unique: true });
  }
  if (!db.objectStoreNames.contains(UPLOADS)) {
    const s = db.createObjectStore(UPLOADS, { keyPath: "id", autoIncrement: true });
    s.createIndex("sessionId", "sessionId");
    s.createIndex("sessionField", ["sessionId", "fieldKey"]);
    s.createIndex("capturedAt", "capturedAt");
  }
  if (!db.objectStoreNames.contains(ANSWERS)) {
    const s = db.createObjectStore(ANSWERS, { keyPath: "key" });
    s.createIndex("sessionId", "sessionId");
  }
}

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => upgrade(r.result);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => {
        dbPromise = null;
        reject(r.error);
      };
    });
  }
  return dbPromise;
}

/** Promise for one IDBRequest. Safe to await inside transact(). */
export function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Run `fn(stores)` in one transaction. Resolves with fn's result once the
 * transaction commits. Inside fn, only await IDB requests (via req()): awaiting
 * anything else lets the transaction auto-commit early.
 */
export async function transact(names, mode, fn) {
  const db = await open();
  const list = [].concat(names);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(list, mode);
    const stores = Object.fromEntries(list.map((n) => [n, tx.objectStore(n)]));
    let result;
    let failed = false;
    tx.oncomplete = () => (failed ? null : resolve(result));
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
    Promise.resolve()
      .then(() => fn(stores, tx))
      .then(
        (r) => {
          result = r;
        },
        (e) => {
          failed = true;
          try {
            tx.abort();
          } catch {}
          reject(e);
        },
      );
  });
}
