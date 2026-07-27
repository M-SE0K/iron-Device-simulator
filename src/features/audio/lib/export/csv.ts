import type { AnalysisFrame } from "@/features/audio/types";

export function framesToCsv(frames: AnalysisFrame[]): string {
  const header = "time,temperature,excursion";
  const rows = frames.map(
    (f) => `${f.time},${f.temperature},${f.excursion}`,
  );
  return [header, ...rows].join("\n");
}
