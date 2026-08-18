import { useCallback } from "react";
import type { AnalysisFrame } from "@/features/audio/types";
import type { FrameLog } from "@/features/audio/lib/frame-log";
import type {
  SaveWorkspaceInput,
  SessionStatus,
} from "@/features/audio/lib/cache/workspace";
import type { TempThresholds } from "@/features/audio/lib/render/detect-events";

interface WorkspaceSaveSource {
  originalFile: File;
  capturedAudio: Blob | null;
}

interface WorkspaceSaveRequest {
  name: string;
  audioDuration: number | null;
  source: WorkspaceSaveSource;
}

interface UseWorkspaceSaveOptions {
  frameLog: FrameLog;
  thresholds: TempThresholds;
  getProtectedBlob: () => Blob | null;
  saveCurrent: (input: SaveWorkspaceInput) => Promise<void>;
}

function computeMeasurementSummary(
  frames: AnalysisFrame[],
  thresholds: TempThresholds,
): { peakTemp: number | null; peakExcursion: number | null; status: SessionStatus | null } {
  if (frames.length === 0) return { peakTemp: null, peakExcursion: null, status: null };
  let peakTemp = -Infinity;
  let peakExcursion = 0;
  for (const frame of frames) {
    peakTemp = Math.max(peakTemp, frame.temperature);
    peakExcursion = Math.max(peakExcursion, Math.abs(frame.excursion));
  }
  const status: SessionStatus =
    peakTemp >= thresholds.danger ? "danger" : peakTemp >= thresholds.warn ? "warning" : "normal";
  return { peakTemp, peakExcursion, status };
}

export function useWorkspaceSave({
  frameLog,
  thresholds,
  getProtectedBlob,
  saveCurrent,
}: UseWorkspaceSaveOptions) {
  return useCallback(async ({ name, audioDuration, source }: WorkspaceSaveRequest) => {
    const frames = frameLog.toFrames();
    const protectedAudio = getProtectedBlob();
    const { peakTemp, peakExcursion, status } = computeMeasurementSummary(frames, thresholds);

    const capturedAudio = source.capturedAudio;
    const audioBlob     = capturedAudio ?? source.originalFile;
    const audioFileName = capturedAudio ? `${name}.wav` : source.originalFile.name;
    const audioType     = capturedAudio ? "audio/wav" : source.originalFile.type;

    await saveCurrent({
      name,
      audioFileName,
      audioDuration,
      analysisMode: "realtime",
      frames,
      audioBlob,
      audioType,
      protectedAudioBlob: protectedAudio,
      peakTemp,
      peakExcursion,
      status,
    });
  }, [frameLog, thresholds, getProtectedBlob, saveCurrent]);
}
