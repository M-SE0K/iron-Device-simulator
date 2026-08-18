export function hasIndexedDb(): boolean {
  return typeof window !== "undefined" && !!window.indexedDB;
}

export interface OpenIndexedDbOptions {
  name: string;
  version: number;
  upgrade?: (db: IDBDatabase) => void;
}

export function openIndexedDb(options: OpenIndexedDbOptions): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(options.name, options.version);
    req.onupgradeneeded = () => options.upgrade?.(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export function runTx(
  db: IDBDatabase,
  storeNames: string | string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    run(tx);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

export function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}
