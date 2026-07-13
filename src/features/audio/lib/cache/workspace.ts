// ── 작업 영역(Workspace) IndexedDB 저장소 ───────────────────────────────────
// 대시보드 "저장" 버튼으로 만든 세션(오디오 원본 + 분석 그래프 프레임)을 브라우저에
// 영구 보관한다 — 탭을 닫아도 유지된다(sessionStorage 기반 차트 캐시 lib/cache/frame.ts
// 와는 다른 수명. 그쪽은 "표시용" 임시 캐시, 이쪽은 사용자가 명시적으로 보존한 세션).
//   · meta 스토어: 목록 렌더용 가벼운 메타데이터(이름/생성일/길이/프레임수 등)
//   · payload 스토어: 실제 프레임 배열 + 오디오 Blob — 목록에는 안 실어 무거운 로드를 피한다.
import { AnalysisFrame } from "@/features/audio/types";

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
}

export interface WorkspacePayload {
  frames: AnalysisFrame[];
  audioBlob: Blob | null;
  audioType: string | null;
}

export interface SaveWorkspaceInput {
  name: string;
  audioFileName: string | null;
  audioDuration: number | null;
  analysisMode: "realtime" | "batch";
  frames: AnalysisFrame[];
  audioBlob: Blob | null;
  audioType: string | null;
  peakTemp: number | null;
  peakExcursion: number | null;
  status: SessionStatus | null;
}

function hasIdb(): boolean {
  return typeof window !== "undefined" && !!window.indexedDB;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE))    db.createObjectStore(META_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(PAYLOAD_STORE)) db.createObjectStore(PAYLOAD_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// 차트 렌더 필드만 남겨 저장 용량을 줄인다 (lib/cache/frame.ts의 slim()과 동일 정책).
function slim(frames: AnalysisFrame[]): AnalysisFrame[] {
  return frames.map((f) => ({ time: f.time, temperature: f.temperature, excursion: f.excursion }));
}

export async function listWorkspaceItems(): Promise<WorkspaceItemMeta[]> {
  if (!hasIdb()) return [];
  try {
    const db = await openDb();
    const items = await new Promise<WorkspaceItemMeta[]>((resolve, reject) => {
      const tx  = db.transaction(META_STORE, "readonly");
      const req = tx.objectStore(META_STORE).getAll();
      req.onsuccess = () => resolve(req.result as WorkspaceItemMeta[]);
      req.onerror   = () => reject(req.error);
    });
    db.close();
    return items.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function saveWorkspaceItem(input: SaveWorkspaceInput): Promise<WorkspaceItemMeta | null> {
  if (!hasIdb()) return null;
  const frames = slim(input.frames);
  const now = Date.now();
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
  };
  const payload: WorkspacePayload = {
    frames,
    audioBlob: input.audioBlob,
    audioType: input.audioType,
  };
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([META_STORE, PAYLOAD_STORE], "readwrite");
      tx.objectStore(META_STORE).put(meta);
      tx.objectStore(PAYLOAD_STORE).put(payload, meta.id);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
    db.close();
    return meta;
  } catch {
    return null;
  }
}

export async function renameWorkspaceItem(id: string, name: string): Promise<void> {
  if (!hasIdb()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx    = db.transaction(META_STORE, "readwrite");
      const store = tx.objectStore(META_STORE);
      const req   = store.get(id);
      req.onsuccess = () => {
        const meta = req.result as WorkspaceItemMeta | undefined;
        if (meta) store.put({ ...meta, name, updatedAt: Date.now() });
      };
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore
  }
}

export async function deleteWorkspaceItem(id: string): Promise<void> {
  if (!hasIdb()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([META_STORE, PAYLOAD_STORE], "readwrite");
      tx.objectStore(META_STORE).delete(id);
      tx.objectStore(PAYLOAD_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore
  }
}

export async function getWorkspacePayload(id: string): Promise<WorkspacePayload | null> {
  if (!hasIdb()) return null;
  try {
    const db = await openDb();
    const payload = await new Promise<WorkspacePayload | undefined>((resolve, reject) => {
      const tx  = db.transaction(PAYLOAD_STORE, "readonly");
      const req = tx.objectStore(PAYLOAD_STORE).get(id);
      req.onsuccess = () => resolve(req.result as WorkspacePayload | undefined);
      req.onerror   = () => reject(req.error);
    });
    db.close();
    return payload ?? null;
  } catch {
    return null;
  }
}

/** 프레임 배열 → CSV 문자열 (time, L/R 온도, L/R 익스커션) */
export function framesToCsv(frames: AnalysisFrame[]): string {
  const header = "time,temperature_L,temperature_R,excursion_L,excursion_R";
  const rows = frames.map(
    (f) => `${f.time},${f.temperature[0]},${f.temperature[1]},${f.excursion[0]},${f.excursion[1]}`,
  );
  return [header, ...rows].join("\n");
}

/** 파일명으로 쓰기 부적합한 문자를 안전하게 치환 */
export function sanitizeFileName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "_").trim() || "untitled";
}
