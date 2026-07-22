import { AnalysisFrame } from "@/features/audio/types";

export function slimAnalysisFrames(frames: AnalysisFrame[]): AnalysisFrame[] {
  return frames.map((f) => ({
    time:        f.time,
    temperature: f.temperature,
    excursion:   f.excursion,
  }));
}
