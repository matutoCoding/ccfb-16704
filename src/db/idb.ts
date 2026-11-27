// IndexedDB 轻量封装：结构化记录 + 大对象 Blob 分库存储
const DB_NAME = 'stele-rubbing-db';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs'); // key 为字符串
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const kv = {
  async get<T>(key: string): Promise<T | undefined> {
    const row = await tx<{ key: string; value: T } | undefined>('kv', 'readonly', (s) => s.get(key));
    return row?.value;
  },
  async set<T>(key: string, value: T): Promise<void> {
    await tx('kv', 'readwrite', (s) => s.put({ key, value }));
  },
  async remove(key: string): Promise<void> {
    await tx('kv', 'readwrite', (s) => s.delete(key));
  },
};

export const blobStore = {
  async put(key: string, blob: Blob): Promise<void> {
    await tx('blobs', 'readwrite', (s) => s.put(blob, key));
  },
  async get(key: string): Promise<Blob | undefined> {
    return tx<Blob | undefined>('blobs', 'readonly', (s) => s.get(key));
  },
  async remove(key: string): Promise<void> {
    await tx('blobs', 'readwrite', (s) => s.delete(key));
  },
};
