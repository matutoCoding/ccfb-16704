import type {
  CompareRecord,
  RubbingDocument,
  ScanRecord,
  Settings,
  Stele,
} from './types';

const DB_NAME = 'zhenshi-stele-studio';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('steles')) {
        db.createObjectStore('steles', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('scans')) {
        const store = db.createObjectStore('scans', { keyPath: 'id' });
        store.createIndex('steleId', 'steleId', { unique: false });
      }
      if (!db.objectStoreNames.contains('rubbings')) {
        const store = db.createObjectStore('rubbings', { keyPath: 'id' });
        store.createIndex('steleId', 'steleId', { unique: false });
        store.createIndex('scanId', 'scanId', { unique: false });
      }
      if (!db.objectStoreNames.contains('compares')) {
        const store = db.createObjectStore('compares', { keyPath: 'id' });
        store.createIndex('steleId', 'steleId', { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('assets')) {
        db.createObjectStore('assets', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (objectStore: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = run(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

export async function putRecord<T>(store: string, value: T): Promise<void> {
  await tx(store, 'readwrite', (s) => s.put(value as object) as IDBRequest<IDBValidKey>);
}

export async function getRecord<T>(store: string, id: string): Promise<T | undefined> {
  return tx<T | undefined>(store, 'readonly', (s) => s.get(id) as IDBRequest<T | undefined>);
}

export async function getAllRecords<T>(store: string): Promise<T[]> {
  return tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

export async function deleteRecord(store: string, id: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.delete(id));
}

export async function getAllByIndex<T>(
  store: string,
  indexName: string,
  query: IDBValidKey,
): Promise<T[]> {
  const db = await openDb();
  return new Promise<T[]>((resolve, reject) => {
    const transaction = db.transaction(store, 'readonly');
    const index = transaction.objectStore(store).index(indexName);
    const req = index.getAll(query);
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  steles: {
    list: () => getAllRecords<Stele>('steles'),
    get: (id: string) => getRecord<Stele>('steles', id),
    put: (value: Stele) => putRecord('steles', value),
    delete: (id: string) => deleteRecord('steles', id),
  },
  scans: {
    list: () => getAllRecords<ScanRecord>('scans'),
    byStele: (steleId: string) => getAllByIndex<ScanRecord>('scans', 'steleId', steleId),
    get: (id: string) => getRecord<ScanRecord>('scans', id),
    put: (value: ScanRecord) => putRecord('scans', value),
    delete: (id: string) => deleteRecord('scans', id),
  },
  rubbings: {
    list: () => getAllRecords<RubbingDocument>('rubbings'),
    byStele: (steleId: string) =>
      getAllByIndex<RubbingDocument>('rubbings', 'steleId', steleId),
    get: (id: string) => getRecord<RubbingDocument>('rubbings', id),
    put: (value: RubbingDocument) => putRecord('rubbings', value),
    delete: (id: string) => deleteRecord('rubbings', id),
  },
  compares: {
    list: () => getAllRecords<CompareRecord>('compares'),
    get: (id: string) => getRecord<CompareRecord>('compares', id),
    put: (value: CompareRecord) => putRecord('compares', value),
    delete: (id: string) => deleteRecord('compares', id),
  },
  settings: {
    async get(): Promise<Settings> {
      const existing = await getRecord<Settings>('settings', 'app');
      if (existing) return existing;
      const fallback: Settings = {
        id: 'app',
        defaultDpi: 600,
        tilePx: 4096,
        autoSeed: true,
        renderScale: 1,
      };
      await putRecord('settings', fallback);
      return fallback;
    },
    put: (value: Settings) => putRecord('settings', value),
  },
  async estimate(): Promise<{ usage: number; quota: number } | null> {
    if (!navigator.storage?.estimate) return null;
    const estimate = await navigator.storage.estimate();
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
  },
  async reset(): Promise<void> {
    const database = await openDb();
    await Promise.all(
      Array.from(database.objectStoreNames).map(
        (name) =>
          new Promise<void>((resolve, reject) => {
            const req = database
              .transaction(name, 'readwrite')
              .objectStore(name)
              .clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
          }),
      ),
    );
  },
};

export function uid(prefix = 'id'): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 12)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}
