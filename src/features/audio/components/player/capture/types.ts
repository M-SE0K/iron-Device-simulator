import type { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import type { DecodedPlayback } from "@/features/audio/lib/codec/playback-decode";
import type { PcmFrameStore } from "@/features/audio/lib/pcm-frame-store";

export type CaptureStreamEvent =
  | { type: "reset"; channels: number; sampleRate: number }
  | { type: "chunk"; chunk: Int16Array; channels: number; sampleRate: number }
  | { type: "protected"; frameIndex: number; input: Int16Array; processed: Int16Array; sampleRate: number };

export type CaptureStreamListener = (ev: CaptureStreamEvent) => void;

export type PlaybackMode = "protected" | "original";

export interface PlaybackStreamPump {
  onEngineReady: () => void;
  pushProtected: (processed: Int16Array) => void;
}

export interface CaptureSnapshot {
  channels: number;
  sampleRate: number;
  pcm: PcmFrameStore;
  samplesPerFrame: number;
  totalFrames: number;
}

export interface UseCaptureSessionDeps {
  onStatusChange: (s: AppStatus) => void;
  onFrameReceived: (frame: AnalysisFrame) => void;
  onStreamStart: () => void;
  inputParams: InputParameterValues | undefined;
  playbackMode?: PlaybackMode;
}

export interface WaveformPlayerHandle {
  exportRecordedAudio: () => Blob | null;
  exportProtectedAudio: () => Blob | null;
  getCaptureSnapshot: () => CaptureSnapshot | null;
  subscribeCaptureStream: (fn: CaptureStreamListener) => () => void;
  getDecodedPlayback: () => DecodedPlayback | null;
}
