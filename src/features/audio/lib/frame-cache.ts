// ── 차트 프레임 sessionStorage 캐시 ─────────────────────────────────────────
// 분석 모드(realtime/batch) 탭 전환 및 새로고침(F5) 시 차트가 비워지지 않도록
// 마지막 프레임 버퍼를 sessionStorage에 보존한다.
//   · 수명: 탭이 살아있는 동안(새로고침 포함). 탭을 닫으면 사라진다.
//   · 차트가 실제로 그리는 필드(time/temperature/excursion)만 저장해 직렬화 크기를 줄인다.
//   · 용량 초과(QuotaExceededError) 시 batch(전체 곡선)를 버리고 realtime만이라도 보존한다.
import { AnalysisFrame } from "@/features/audio/types";

const KEY = "irondevice:chart-cache:v1";

export interface FrameCacheSnapshot {
  fileName:       string | null;
  audioDuration:  number | null;
  analysisMode:   "realtime" | "batch";
  realtimeFrames: AnalysisFrame[];
  batchFrames:    AnalysisFrame[];
}

// 차트 렌더에 필요한 필드만 남긴다 (coalescing/event 메타데이터는 정적 뷰에 불필요).
function slim(frames: AnalysisFrame[]): AnalysisFrame[] {
  return frames.map((f) => ({
    time:        f.time,
    temperature: f.temperature,
    excursion:   f.excursion,
  }));
}

export function saveFrameCache(snap: FrameCacheSnapshot): void {
  if (typeof window === "undefined") return;
  const base = {
    fileName:      snap.fileName,
    audioDuration: snap.audioDuration,
    analysisMode:  snap.analysisMode,
  };
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({
      ...base,
      realtimeFrames: slim(snap.realtimeFrames),
      batchFrames:    slim(snap.batchFrames),
    }));
  } catch {
    // 용량 초과 등: batch(가장 큰 데이터)를 버리고 realtime만 재시도
    try {
      window.sessionStorage.setItem(KEY, JSON.stringify({
        ...base,
        realtimeFrames: slim(snap.realtimeFrames),
        batchFrames:    [],
      }));
    } catch {
      // 그래도 실패하면 캐시 포기 (조용히)
    }
  }
}

export function loadFrameCache(): FrameCacheSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FrameCacheSnapshot;
    if (!parsed) return null;
    const hasData = (parsed.realtimeFrames?.length ?? 0) > 0 || (parsed.batchFrames?.length ?? 0) > 0;
    if (!hasData) return null;
    return {
      fileName:       parsed.fileName ?? null,
      audioDuration:  parsed.audioDuration ?? null,
      analysisMode:   parsed.analysisMode === "batch" ? "batch" : "realtime",
      realtimeFrames: parsed.realtimeFrames ?? [],
      batchFrames:    parsed.batchFrames ?? [],
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
