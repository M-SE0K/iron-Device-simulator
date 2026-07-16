import { AnalysisFrame } from "@/features/audio/types";

// 차트 렌더에 필요한 필드만 남긴다 (coalescing/event 메타데이터는 정적 뷰에 불필요).
export function slimAnalysisFrames(frames: AnalysisFrame[]): AnalysisFrame[] {
  return frames.map((f) => ({
    time:        f.time,
    temperature: f.temperature,
    excursion:   f.excursion,
  }));
}
