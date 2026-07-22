import type { QueuedFrame } from "./types";

export const DEFAULT_TEMP_WARN   = 65;
export const DEFAULT_TEMP_DANGER = 75;

export interface TempThresholds {
  warn: number;
  danger: number;
}

const DEFAULT_THRESHOLDS: TempThresholds = { warn: DEFAULT_TEMP_WARN, danger: DEFAULT_TEMP_DANGER };

export function detectEvents(
  bucket: QueuedFrame[],
  prevTemp: [number, number] | null,
  thresholds: TempThresholds = DEFAULT_THRESHOLDS,
): QueuedFrame[] {
  const { warn: TEMP_WARN, danger: TEMP_DANGER } = thresholds;
  const events: QueuedFrame[] = [];
  for (let i = 0; i < bucket.length; i++) {
    const f = bucket[i].frame;
    const prev = i > 0 ? bucket[i - 1].frame : null;
    const prevT = prev ? prev.temperature : prevTemp;

    if (prevT) {
      for (let ch = 0; ch < 2; ch++) {
        const was = prevT[ch];
        const now = f.temperature[ch];
        if ((was < TEMP_WARN && now >= TEMP_WARN) || (was >= TEMP_WARN && now < TEMP_WARN)) {
          events.push(bucket[i]);
          bucket[i].frame = { ...f, isEvent: true, eventType: "temp_warn" };
          break;
        }
        if ((was < TEMP_DANGER && now >= TEMP_DANGER) || (was >= TEMP_DANGER && now < TEMP_DANGER)) {
          events.push(bucket[i]);
          bucket[i].frame = { ...f, isEvent: true, eventType: "temp_danger" };
          break;
        }
      }
    }
    if (bucket[i].frame.isEvent) continue;

    if (prev && i < bucket.length - 1) {
      const next = bucket[i + 1].frame;
      for (let ch = 0; ch < 2; ch++) {
        const cur = Math.abs(f.excursion[ch]);
        if (cur > Math.abs(prev.excursion[ch]) && cur > Math.abs(next.excursion[ch])) {
          events.push(bucket[i]);
          bucket[i].frame = { ...f, isEvent: true, eventType: "exc_peak" };
          break;
        }
      }
    }
  }
  return events;
}
