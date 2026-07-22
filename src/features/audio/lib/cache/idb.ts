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

/** 트랜잭션을 열고 `run`을 실행한 뒤 완료(oncomplete)까지 기다린다 — 쓰기 계열 공용 래퍼. */
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

/** IDBRequest 하나의 결과를 Promise로 감싼다 — 읽기 계열(get/getAll) 공용 래퍼. */
export function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}
