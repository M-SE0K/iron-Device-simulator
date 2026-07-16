// ── 차트 프레임 sessionStorage 캐시 ─────────────────────────────────────────
// 탭 전환 및 새로고침(F5) 시 차트가 비워지지 않도록 마지막 실시간 프레임 버퍼를
// sessionStorage에 보존한다(파일/마이크 두 입력 모드 모두 캡처 기반 단일 버퍼).
//   · 수명: 탭이 살아있는 동안(새로고침 포함). 탭을 닫으면 사라진다.
//   · 차트가 실제로 그리는 필드(time/temperature/excursion)만 저장해 직렬화 크기를 줄인다.
import { AnalysisFrame } from "@/features/audio/types";
import { slimAnalysisFrames } from "./frame-utils";

const KEY = "irondevice:chart-cache:v1";

export interface FrameCacheSnapshot {
  fileName:       string | null;
  audioDuration:  number | null;
  realtimeFrames: AnalysisFrame[];
}

export function saveFrameCache(snap: FrameCacheSnapshot): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({
      fileName:       snap.fileName,
      audioDuration:  snap.audioDuration,
      realtimeFrames: slimAnalysisFrames(snap.realtimeFrames),
    }));
  } catch {
    // 용량 초과(QuotaExceededError) 등: 캐시 포기 (조용히)
  }
}

export function loadFrameCache(): FrameCacheSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FrameCacheSnapshot;
    if (!parsed) return null;
    if ((parsed.realtimeFrames?.length ?? 0) === 0) return null;
    return {
      fileName:       parsed.fileName ?? null,
      audioDuration:  parsed.audioDuration ?? null,
      realtimeFrames: parsed.realtimeFrames ?? [],
    };
  } catch {
    return null;
  }
}

export function clearFrameCache(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
