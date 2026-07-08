import type { QueuedFrame } from "./types";

// Calibration에서 tempWarn/tempDanger를 지정하지 않았을 때(또는 파싱 실패 시)의 기본값 —
// CalibrationContext.tsx의 CALIBRATION_EMPTY와 TemperatureChart.tsx의 markLine이
// 이 값을 공유한다(단일 진실원).
export const DEFAULT_TEMP_WARN   = 65;
export const DEFAULT_TEMP_DANGER = 75;

export interface TempThresholds {
  warn: number;
  danger: number;
}

const DEFAULT_THRESHOLDS: TempThresholds = { warn: DEFAULT_TEMP_WARN, danger: DEFAULT_TEMP_DANGER };

/**
 * bucket 안에서 온도 임계 교차(WARN/DANGER)와 익스커션 피크를 감지한다.
 * 감지된 프레임은 bucket[i].frame을 isEvent/eventType이 채워진 새 객체로
 * 교체한다(제자리 변경) — coalesceFrames가 이후 이 변경을 그대로 읽는다.
 */
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
    // 이전 온도: bucket 내 이전 frame 또는 직전 렌더 사이클의 마지막 온도
    const prevT = prev ? prev.temperature : prevTemp;

    // Temperature threshold crossing 감지
    if (prevT) {
      for (let ch = 0; ch < 2; ch++) {
        const was = prevT[ch];
        const now = f.temperature[ch];
        // WARN crossing (아래→위 또는 위→아래)
        if ((was < TEMP_WARN && now >= TEMP_WARN) || (was >= TEMP_WARN && now < TEMP_WARN)) {
          events.push(bucket[i]);
          bucket[i].frame = { ...f, isEvent: true, eventType: "temp_warn" };
          break;
        }
        // DANGER crossing
        if ((was < TEMP_DANGER && now >= TEMP_DANGER) || (was >= TEMP_DANGER && now < TEMP_DANGER)) {
          events.push(bucket[i]);
          bucket[i].frame = { ...f, isEvent: true, eventType: "temp_danger" };
          break;
        }
      }
    }
    // 이미 이벤트로 잡힌 frame은 skip
    if (bucket[i].frame.isEvent) continue;

    // Excursion peak 감지: 앞뒤 frame보다 절대값이 큰 극값
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
