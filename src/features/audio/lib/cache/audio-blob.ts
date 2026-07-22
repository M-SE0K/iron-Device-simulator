import { hasIndexedDb, openIndexedDb } from "./idb";

const DB_NAME     = "irondevice";
const STORE       = "audio";
const KEY         = "current";
const POINTER_KEY = "irondevice:audio-ptr:v1";

interface AudioPointer {
  name:         string;
  type:         string;
  lastModified: number;
}

function openDb(): Promise<IDBDatabase> {
  return openIndexedDb({
    name: DB_NAME,
    version: 1,
    upgrade: (db) => {
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    },
  });
}

export async function putAudio(file: File): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(file, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
    db.close();
    const ptr: AudioPointer = { name: file.name, type: file.type, lastModified: file.lastModified };
    window.sessionStorage.setItem(POINTER_KEY, JSON.stringify(ptr));
  } catch {
  }
}

export async function getCachedAudio(): Promise<File | null> {
  if (!hasIndexedDb()) return null;
  try {
    const raw = window.sessionStorage.getItem(POINTER_KEY);
    if (!raw) {
      await clearAudio();
      return null;
    }
    const ptr = JSON.parse(raw) as AudioPointer;
    const db  = await openDb();
    const stored = await new Promise<Blob | File | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const r  = tx.objectStore(STORE).get(KEY);
      r.onsuccess = () => resolve(r.result as Blob | File | undefined);
      r.onerror   = () => reject(r.error);
    });
    db.close();
    if (!stored) return null;
    return new File([stored], ptr.name, { type: ptr.type, lastModified: ptr.lastModified });
  } catch {
    return null;
  }
}

export async function clearAudio(): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    window.sessionStorage.removeItem(POINTER_KEY);
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
    db.close();
  } catch {
  }
}
