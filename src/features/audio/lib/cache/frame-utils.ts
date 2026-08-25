import { AnalysisFrame } from "@/features/audio/types";

export function slimAnalysisFrames(frames: AnalysisFrame[]): AnalysisFrame[] {
  /* speakerFault 는 값이 아니라 "이 값을 표시하면 안 된다"는 표시라서 같이 남긴다 —
   * 온도가 이미 0 으로 깔려 있어 복원 시점에 값만으로는 되짚을 수 없다. */
  return frames.map((f) => ({
    time:        f.time,
    temperature: f.temperature,
    excursion:   f.excursion,
    ...(f.speakerFault ? { speakerFault: f.speakerFault } : {}),
  }));
}
