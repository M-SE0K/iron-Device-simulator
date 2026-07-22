/**
 * export/csv.ts — 분석 프레임 → 내보내기 형식 변환.
 *
 * 측정 기록 드로어의 "CSV 내보내기"가 쓴다. 저장/조회(IndexedDB)와는 무관한 순수 변환이라
 * lib/cache/workspace.ts 에서 분리했다.
 */

import type { AnalysisFrame } from "@/features/audio/types";

/** 프레임 배열 → CSV 문자열 (time, L/R 온도, L/R 익스커션) */
export function framesToCsv(frames: AnalysisFrame[]): string {
  const header = "time,temperature_L,temperature_R,excursion_L,excursion_R";
  const rows = frames.map(
    (f) => `${f.time},${f.temperature[0]},${f.temperature[1]},${f.excursion[0]},${f.excursion[1]}`,
  );
  return [header, ...rows].join("\n");
}
