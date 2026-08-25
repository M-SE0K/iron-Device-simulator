import { useCallback } from "react";
import type { AnalysisFrame } from "@/features/audio/types";
import type { FrameLog } from "@/features/audio/lib/frame-log";
import type {
  SaveWorkspaceInput,
  SessionStatus,
} from "@/features/audio/lib/cache/workspace";
import type { MetricThresholds } from "@/features/audio/lib/render/detect-events";
import { toMm } from "@/features/audio/lib/units";

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
  thresholds: MetricThresholds;
  getProtectedBlob: () => Blob | null;
  saveCurrent: (input: SaveWorkspaceInput) => Promise<void>;
}

function computeMeasurementSummary(
  frames: AnalysisFrame[],
  thresholds: MetricThresholds,
): { peakTemp: number | null; peakExcursion: number | null; status: SessionStatus | null } {
  if (frames.length === 0) return { peakTemp: null, peakExcursion: null, status: null };
  let peakTemp = -Infinity;
  let peakExcursion = 0;
  for (const frame of frames) {
    peakTemp = Math.max(peakTemp, frame.temperature);
    peakExcursion = Math.max(peakExcursion, Math.abs(frame.excursion));
  }
  /* WARN 단계가 사라졌으므로 한계(Tmax/Xmax) 초과만 danger로 본다. 저장된 예전 기록의
   * "warning"은 그대로 남지만 새로 만들어지지는 않는다. */
  const overTemp = peakTemp >= thresholds.tmax;
  const overExc  = thresholds.xmax > 0 && toMm(peakExcursion) >= thresholds.xmax;
  const status: SessionStatus = overTemp || overExc ? "danger" : "normal";
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
