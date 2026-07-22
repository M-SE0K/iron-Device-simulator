import { AnalysisFrame } from "@/features/audio/types";
import { slimAnalysisFrames } from "./frame-utils";
import { hasIndexedDb, openIndexedDb, requestToPromise, runTx } from "./idb";

const DB_NAME       = "irondevice-workspace";
const DB_VERSION    = 1;
const META_STORE    = "meta";
const PAYLOAD_STORE = "payload";

export type SessionStatus = "normal" | "warning" | "danger";

export interface WorkspaceItemMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  audioFileName: string | null;
  audioDuration: number | null;
  analysisMode: "realtime" | "batch";
  frameCount: number;
  peakTemp: number | null;
  peakExcursion: number | null;
  status: SessionStatus | null;
  hasProtectedAudio?: boolean;
}

export interface WorkspacePayload {
  frames: AnalysisFrame[];
  audioBlob: Blob | null;
  audioType: string | null;
  protectedAudioBlob?: Blob | null;
  protectedAudioType?: string | null;
}

export interface SaveWorkspaceInput {
  name: string;
  audioFileName: string | null;
  audioDuration: number | null;
  analysisMode: "realtime" | "batch";
  frames: AnalysisFrame[];
  audioBlob: Blob | null;
  audioType: string | null;
  protectedAudioBlob?: Blob | null;
  protectedAudioType?: string | null;
  peakTemp: number | null;
  peakExcursion: number | null;
  status: SessionStatus | null;
}

function openDb(): Promise<IDBDatabase> {
  return openIndexedDb({
    name: DB_NAME,
    version: DB_VERSION,
    upgrade: (db) => {
      if (!db.objectStoreNames.contains(META_STORE))    db.createObjectStore(META_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(PAYLOAD_STORE)) db.createObjectStore(PAYLOAD_STORE);
    },
  });
}

export async function listWorkspaceItems(): Promise<WorkspaceItemMeta[]> {
  if (!hasIndexedDb()) return [];
  try {
    const db = await openDb();
    const items = await requestToPromise<WorkspaceItemMeta[]>(
      db.transaction(META_STORE, "readonly").objectStore(META_STORE).getAll(),
    );
    db.close();
    return items.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function saveWorkspaceItem(input: SaveWorkspaceInput): Promise<WorkspaceItemMeta | null> {
  if (!hasIndexedDb()) return null;
  const frames = slimAnalysisFrames(input.frames);
  const now = Date.now();
  const protectedAudioBlob = input.protectedAudioBlob ?? null;
  const meta: WorkspaceItemMeta = {
    id: crypto.randomUUID(),
    name: input.name,
    createdAt: now,
    updatedAt: now,
    audioFileName: input.audioFileName,
    audioDuration: input.audioDuration,
    analysisMode: input.analysisMode,
    frameCount: frames.length,
    peakTemp: input.peakTemp,
    peakExcursion: input.peakExcursion,
    status: input.status,
    hasProtectedAudio: protectedAudioBlob !== null,
  };
  const payload: WorkspacePayload = {
    frames,
    audioBlob: input.audioBlob,
    audioType: input.audioType,
    protectedAudioBlob,
    protectedAudioType: protectedAudioBlob ? (input.protectedAudioType ?? "audio/wav") : null,
  };
  try {
    const db = await openDb();
    await runTx(db, [META_STORE, PAYLOAD_STORE], "readwrite", (tx) => {
      tx.objectStore(META_STORE).put(meta);
      tx.objectStore(PAYLOAD_STORE).put(payload, meta.id);
    });
    db.close();
    return meta;
  } catch {
    return null;
  }
}

export async function renameWorkspaceItem(id: string, name: string): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    const db = await openDb();
    await runTx(db, META_STORE, "readwrite", (tx) => {
      const store = tx.objectStore(META_STORE);
      const req   = store.get(id);
      req.onsuccess = () => {
        const meta = req.result as WorkspaceItemMeta | undefined;
        if (meta) store.put({ ...meta, name, updatedAt: Date.now() });
      };
    });
    db.close();
  } catch {
  }
}

export async function deleteWorkspaceItem(id: string): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    const db = await openDb();
    await runTx(db, [META_STORE, PAYLOAD_STORE], "readwrite", (tx) => {
      tx.objectStore(META_STORE).delete(id);
      tx.objectStore(PAYLOAD_STORE).delete(id);
    });
    db.close();
  } catch {
  }
}

export async function getWorkspacePayload(id: string): Promise<WorkspacePayload | null> {
  if (!hasIndexedDb()) return null;
  try {
    const db = await openDb();
    const payload = await requestToPromise<WorkspacePayload | undefined>(
      db.transaction(PAYLOAD_STORE, "readonly").objectStore(PAYLOAD_STORE).get(id),
    );
    db.close();
    return payload ?? null;
  } catch {
    return null;
  }
}

