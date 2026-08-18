import type { AnalysisFrame } from "../../types";

export const DEFAULT_TEMP_WARN   = 65;
export const DEFAULT_TEMP_DANGER = 75;

export interface TempThresholds {
  warn: number;
  danger: number;
}

const DEFAULT_THRESHOLDS: TempThresholds = { warn: DEFAULT_TEMP_WARN, danger: DEFAULT_TEMP_DANGER };

export function detectEvents(
  bucket: AnalysisFrame[],
  prevTemp: number | null,
  thresholds: TempThresholds = DEFAULT_THRESHOLDS,
): AnalysisFrame[] {
  const { warn: TEMP_WARN, danger: TEMP_DANGER } = thresholds;
  const events: AnalysisFrame[] = [];
  for (let i = 0; i < bucket.length; i++) {
    const f = bucket[i];
    const prev = i > 0 ? bucket[i - 1] : null;
    const prevT = prev ? prev.temperature : prevTemp;

    if (prevT !== null) {
      const was = prevT;
      const now = f.temperature;
      if (
        (was < TEMP_WARN && now >= TEMP_WARN) || (was >= TEMP_WARN && now < TEMP_WARN)
        || (was < TEMP_DANGER && now >= TEMP_DANGER) || (was >= TEMP_DANGER && now < TEMP_DANGER)
      ) {
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
