import type { AnalysisFrame } from "../../types";

/** 온도 한계 (°C) */
export const DEFAULT_TMAX = 120;
/** 변위 한계 (mm) */
export const DEFAULT_XMAX = 0.55;

export interface MetricThresholds {
  /** °C */
  tmax: number;
  /** mm */
  xmax: number;
}

const DEFAULT_THRESHOLDS: MetricThresholds = { tmax: DEFAULT_TMAX, xmax: DEFAULT_XMAX };

export function detectEvents(
  bucket: AnalysisFrame[],
  prevTemp: number | null,
  thresholds: MetricThresholds = DEFAULT_THRESHOLDS,
): AnalysisFrame[] {
  const { tmax: TMAX } = thresholds;
  const events: AnalysisFrame[] = [];
  for (let i = 0; i < bucket.length; i++) {
    const f = bucket[i];
    const prev = i > 0 ? bucket[i - 1] : null;
    const prevT = prev ? prev.temperature : prevTemp;

    if (prevT !== null) {
      const was = prevT;
      const now = f.temperature;
      if ((was < TMAX && now >= TMAX) || (was >= TMAX && now < TMAX)) {
        bucket[i] = { ...f, isEvent: true };
        events.push(bucket[i]);
      }
    }
    if (bucket[i].isEvent) continue;

    if (prev && i < bucket.length - 1) {
      const next = bucket[i + 1];
      const cur = Math.abs(f.excursion);
      if (cur > Math.abs(prev.excursion) && cur > Math.abs(next.excursion)) {
        bucket[i] = { ...f, isEvent: true };
        events.push(bucket[i]);
      }
    }
  }
  return events;
}
