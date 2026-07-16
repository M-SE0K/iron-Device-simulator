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
