/**
 * Typed wrapper over a single IndexedDB object store that mirrors cacheable
 * React Query responses (see cacheCatalog.ts). Every entry is scoped to the
 * user that fetched it so a browser shared by two accounts never seeds one
 * user's view with another's mail. All operations fail soft: when IndexedDB is
 * unavailable (private mode, an old browser, a non-DOM context) they no-op and
 * the app falls back to its normal network-only behavior.
 *
 * Hand-rolled over the raw IndexedDB API (no external `idb` dependency),
 * mirroring the budget app's IndexedDbAccessor idiom.
 */
export interface CachedQuery {
  /** React Query key = the request URL. Primary key of the store. */
  key: string;
  /** Structured-cloneable response payload (class instances become plain). */
  payload: unknown;
  /** id of the user who fetched it; entries for other users are ignored. */
  userId: string;
  /** epoch ms the payload was last written, for catalog maxAge checks. */
  lastFetchedAt: number;
}

const DB_NAME = "inbox-query-cache";
const STORE = "queries";
const DB_VERSION = 1;

class QueryCacheStore {
  private db: IDBDatabase | null = null;
  private available = true;

  private init = (): Promise<IDBDatabase> => {
    return new Promise((resolve, reject) => {
      if (!this.available || typeof indexedDB === "undefined") {
        this.available = false;
        reject(new Error("IndexedDB is not available"));
        return;
      }

      if (this.db) {
        resolve(this.db);
        return;
      }

      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        this.available = false;
        console.warn("IndexedDB unavailable; query cache disabled.", err);
        reject(err);
        return;
      }

      request.onerror = () => {
        this.available = false;
        console.warn("IndexedDB unavailable; query cache disabled.", request.error);
        reject(request.error);
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE)) {
          database.createObjectStore(STORE, { keyPath: "key" });
        }
      };
    });
  };

  /**
   * The browser can close a connection at any time, and the cached handle then
   * throws on every call. Reopens once, then resolves null so callers fail soft.
   */
  private openStore = async (mode: IDBTransactionMode): Promise<IDBObjectStore | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const database = await this.init();
        return database.transaction(STORE, mode).objectStore(STORE);
      } catch {
        this.db = null;
      }
    }
    return null;
  };

  getAll = async (): Promise<CachedQuery[]> => {
    if (!this.available) return [];
    const store = await this.openStore("readonly");
    if (!store) return [];
    return new Promise<CachedQuery[]>((resolve) => {
      const request = store.getAll();
      request.onerror = () => resolve([]);
      request.onsuccess = () => resolve(request.result as CachedQuery[]);
    });
  };

  put = async (entry: CachedQuery): Promise<void> => {
    if (!this.available) return;
    const store = await this.openStore("readwrite");
    if (!store) return;
    return new Promise<void>((resolve) => {
      const request = store.put(entry);
      request.onerror = () => {
        console.error("IndexedDB write failed", request.error);
        resolve();
      };
      request.onsuccess = () => resolve();
    });
  };

  delete = async (key: string): Promise<void> => {
    if (!this.available) return;
    const store = await this.openStore("readwrite");
    if (!store) return;
    return new Promise<void>((resolve) => {
      const request = store.delete(key);
      // fail soft — a failed eviction just leaves a stale entry
      request.onerror = () => resolve();
      request.onsuccess = () => resolve();
    });
  };

  clear = async (): Promise<void> => {
    if (!this.available) return;
    const store = await this.openStore("readwrite");
    if (!store) return;
    return new Promise<void>((resolve) => {
      const request = store.clear();
      request.onerror = () => resolve();
      request.onsuccess = () => resolve();
    });
  };
}

const store = new QueryCacheStore();

export const idbGetAllQueries = (): Promise<CachedQuery[]> => store.getAll();

export const idbPutQuery = (entry: CachedQuery): Promise<void> => store.put(entry);

export const idbDeleteQuery = (key: string): Promise<void> => store.delete(key);

export const idbClearQueries = (): Promise<void> => store.clear();
