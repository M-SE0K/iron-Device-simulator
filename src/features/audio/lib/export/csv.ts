import type { AnalysisFrame } from "@/features/audio/types";

export function framesToCsv(frames: AnalysisFrame[]): string {
  const header = "time,temperature_L,temperature_R,excursion_L,excursion_R";
  const rows = frames.map(
    (f) => `${f.time},${f.temperature[0]},${f.temperature[1]},${f.excursion[0]},${f.excursion[1]}`,
  );
  return [header, ...rows].join("\n");
}
