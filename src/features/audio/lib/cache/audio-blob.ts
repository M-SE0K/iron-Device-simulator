import { hasIndexedDb, openIndexedDb, requestToPromise, runTx } from "./idb";
import { hasSessionJson, readSessionJson, removeSessionJson, writeSessionJson } from "./session-json";

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
    await runTx(db, STORE, "readwrite", (tx) => tx.objectStore(STORE).put(file, KEY));
    db.close();
    const ptr: AudioPointer = { name: file.name, type: file.type, lastModified: file.lastModified };
    writeSessionJson(POINTER_KEY, ptr);
  } catch {
  }
}

export async function getCachedAudio(): Promise<File | null> {
  if (!hasIndexedDb()) return null;
  try {
    const pointerExists = hasSessionJson(POINTER_KEY);
    const ptr = readSessionJson<AudioPointer>(POINTER_KEY);
    if (!ptr) {
      if (pointerExists === false) await clearAudio();
      return null;
    }
    const db  = await openDb();
    const stored = await requestToPromise<Blob | File | undefined>(
      db.transaction(STORE, "readonly").objectStore(STORE).get(KEY),
    );
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
    removeSessionJson(POINTER_KEY);
    const db = await openDb();
    await runTx(db, STORE, "readwrite", (tx) => tx.objectStore(STORE).delete(KEY));
    db.close();
  } catch {
  }
}
