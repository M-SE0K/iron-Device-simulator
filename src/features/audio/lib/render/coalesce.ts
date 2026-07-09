// 출력 큐에 쌓인 여러 프레임을 하나의 요약 프레임으로 병합하는 coalesce 로직.
import type { AnalysisFrame } from "../../types";
import type { QueuedFrame } from "./types";

/** bucket(출력 큐에 쌓인 프레임들)을 하나의 요약 frame으로 병합한다. */
export function coalesceFrames(bucket: QueuedFrame[]): AnalysisFrame {
  if (bucket.length === 1) return bucket[0].frame;

  const frames = bucket.map(q => q.frame);
  const latest = frames[frames.length - 1];

  return {
    ...latest,
    sourceCount: frames.length,
    timeStart:   frames[0].time,
    timeEnd:     latest.time,
    // 온도: 최신값 사용, 구간 내 최댓값 별도 보존
    temperatureMax: [
      Math.max(...frames.map(f => f.temperature[0])),
      Math.max(...frames.map(f => f.temperature[1])),
    ],
    // 익스커션: 최신값 사용, 구간 내 min/max envelope 보존
    excursionMin: [
      Math.min(...frames.map(f => f.excursion[0])),
      Math.min(...frames.map(f => f.excursion[1])),
    ],
    excursionMax: [
      Math.max(...frames.map(f => f.excursion[0])),
      Math.max(...frames.map(f => f.excursion[1])),
    ],
  };
}
