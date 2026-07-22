import { AnalysisFrame } from "@/features/audio/types";
import { slimAnalysisFrames } from "./frame-utils";
import { readSessionJson, writeSessionJson, removeSessionJson } from "./session-json";

const KEY = "irondevice:chart-cache:v1";

export interface FrameCacheSnapshot {
  fileName:       string | null;
  audioDuration:  number | null;
  realtimeFrames: AnalysisFrame[];
}

export function saveFrameCache(snap: FrameCacheSnapshot): void {
  writeSessionJson(KEY, {
    fileName:       snap.fileName,
    audioDuration:  snap.audioDuration,
    realtimeFrames: slimAnalysisFrames(snap.realtimeFrames),
  });
}

export function loadFrameCache(): FrameCacheSnapshot | null {
  const parsed = readSessionJson<FrameCacheSnapshot>(KEY);
  if (!parsed) return null;
  if ((parsed.realtimeFrames?.length ?? 0) === 0) return null;
  return {
    fileName:       parsed.fileName ?? null,
    audioDuration:  parsed.audioDuration ?? null,
    realtimeFrames: parsed.realtimeFrames ?? [],
  };
}

export function clearFrameCache(): void {
  removeSessionJson(KEY);
}
