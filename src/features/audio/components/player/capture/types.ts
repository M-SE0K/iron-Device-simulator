import type { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";

export type CaptureStreamEvent =
  | { type: "reset"; channels: number; sampleRate: number }
  | { type: "chunk"; chunk: ArrayBuffer; channels: number; sampleRate: number }
  | { type: "protected"; frameIndex: number; input: Int16Array; processed: Int16Array; sampleRate: number };

export type CaptureStreamListener = (ev: CaptureStreamEvent) => void;

export interface UseCaptureSessionDeps {
  status: AppStatus;
  onStatusChange: (s: AppStatus) => void;
  onFrameReceived: (frame: AnalysisFrame) => void;
  onStreamStart: () => void;
  inputParams: InputParameterValues | undefined;
}
