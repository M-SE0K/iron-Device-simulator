// ── 오디오 원본 블롭 IndexedDB 캐시 ─────────────────────────────────────────
// 새로고침(F5) 후에도 파형(WaveSurfer)을 복원하려면 오디오 원본이 필요하다.
// File/Blob은 sessionStorage(문자열·~5MB)에 담기 부적합하므로 IndexedDB에 보관한다.
//   · 수명 일치: IndexedDB 자체는 탭을 닫아도 남지만, "현재 세션에 캐시가 있다"는 포인터를 sessionStorage에 둔다. 탭을 닫으면 포인터가 사라지고, 다음 마운트 시 stale 블롭을 정리(clear)하므로 차트 캐시(sessionStorage)와 같은 수명이 된다.
//   · 비동기 + 대용량 OK → 직렬화/용량 초과(QuotaExceeded) 걱정이 없다.

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
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function hasIdb(): boolean {
  return typeof window !== "undefined" && !!window.indexedDB;
}

/** 오디오 원본을 IndexedDB에 저장하고 세션 포인터를 기록한다. */
export async function putAudio(file: File): Promise<void> {
  if (!hasIdb()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(file, KEY); // File은 structured clone으로 그대로 저장됨
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
    db.close();
    const ptr: AudioPointer = { name: file.name, type: file.type, lastModified: file.lastModified };
    window.sessionStorage.setItem(POINTER_KEY, JSON.stringify(ptr));
  } catch {
    // 저장 실패 시 조용히 포기 (파형 복원만 안 될 뿐 동작엔 지장 없음)
  }
}

/**
 * 세션 포인터가 있으면 캐시된 오디오를 File로 복원해 반환한다.
 * 포인터가 없으면(탭이 닫혔던 세션) stale 블롭을 정리하고 null을 반환한다.
 */
export async function getCachedAudio(): Promise<File | null> {
  if (!hasIdb()) return null;
  try {
    const raw = window.sessionStorage.getItem(POINTER_KEY);
    if (!raw) {
      await clearAudio(); // 포인터 없음 = 다른 세션의 잔여물 → 정리
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
    // 메타데이터(name/type/lastModified)를 보존해 File로 재구성
    return new File([stored], ptr.name, { type: ptr.type, lastModified: ptr.lastModified });
  } catch {
    return null;
  }
}

/** 캐시된 오디오와 세션 포인터를 모두 제거한다. */
export async function clearAudio(): Promise<void> {
  if (!hasIdb()) return;
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
    // ignore
  }
}
