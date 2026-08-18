import type { AnalysisFrame } from "../../types";

export function coalesceFrames(bucket: AnalysisFrame[]): AnalysisFrame {
  if (bucket.length === 1) return bucket[0];

  const latest = bucket[bucket.length - 1];

  return {
    ...latest,
    temperatureMax: Math.max(...bucket.map(f => f.temperature)),
    excursionMin:   Math.min(...bucket.map(f => f.excursion)),
    excursionMax:   Math.max(...bucket.map(f => f.excursion)),
  };
}
