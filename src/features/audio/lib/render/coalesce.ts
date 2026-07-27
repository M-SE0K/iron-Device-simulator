import type { AnalysisFrame } from "../../types";
import type { QueuedFrame } from "./types";

export function coalesceFrames(bucket: QueuedFrame[]): AnalysisFrame {
  if (bucket.length === 1) return bucket[0].frame;

  const frames = bucket.map(q => q.frame);
  const latest = frames[frames.length - 1];

  return {
    ...latest,
    sourceCount: frames.length,
    timeStart:   frames[0].time,
    timeEnd:     latest.time,
    temperatureMax: Math.max(...frames.map(f => f.temperature)),
    excursionMin:   Math.min(...frames.map(f => f.excursion)),
    excursionMax:   Math.max(...frames.map(f => f.excursion)),
  };
}
