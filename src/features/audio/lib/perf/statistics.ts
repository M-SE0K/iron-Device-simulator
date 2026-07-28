import { round3 } from "@/shared/lib/utils";

export interface StatBlock {
  count: number;
  avg: number | null;
  min: number | null;
  max: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export function summarizeStats(values: number[]): StatBlock {
  if (values.length === 0) {
    return { count: 0, avg: null, min: null, max: null, p50: null, p95: null, p99: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    avg: round3(sum / sorted.length),
    min: round3(sorted[0]),
    max: round3(sorted[sorted.length - 1]),
    p50: round3(pct(50)),
    p95: round3(pct(95)),
    p99: round3(pct(99)),
  };
}
