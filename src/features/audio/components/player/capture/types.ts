import type { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";

export type CaptureStreamEvent =
  | { type: "reset"; channels: number; sampleRate: number }
  | { type: "chunk"; chunk: ArrayBuffer; channels: number; sampleRate: number }
  | { type: "protected"; frameIndex: number; input: Int16Array; processed: Int16Array; sampleRate: number };

export type CaptureStreamListener = (ev: CaptureStreamEvent) => void;

/**
 * 세션 시작~현재까지 캡처된 전 채널 원본 PCM을 복사 없이 들여다보는 스냅샷.
 * getRecordedBlob()(WAV 인코딩, Workspace 저장 전용)과 달리 이건 O(1)이다 — `frames`가
 * rawCaptureRef가 들고 있는 배열 참조 그대로라, 세션이 길어져도 호출 비용이 늘지 않는다.
 * 채널 뷰 백필/온디맨드 확대처럼 "읽기만" 하는 경로는 이쪽을 쓴다.
 */
export interface CaptureSnapshot {
  channels: number;
  sampleRate: number;
  /** 인터리브 int16 프레임들. 살아있는 참조 — 이후 도착분이 계속 append된다. */
  frames: readonly ArrayBuffer[];
  /** 프레임 1개가 담는 채널당 샘플 수. reframer가 고정 크기로 내므로 전 프레임 동일하다. */
  samplesPerFrame: number;
  /** 스냅샷 시점의 누적 채널당 샘플 수 = frames.length * samplesPerFrame. */
  totalFrames: number;
}

export interface UseCaptureSessionDeps {
  status: AppStatus;
  onStatusChange: (s: AppStatus) => void;
  onFrameReceived: (frame: AnalysisFrame) => void;
  onStreamStart: () => void;
  inputParams: InputParameterValues | undefined;
}

export interface WaveformPlayerHandle {
  sendMessage: (msg: object) => void;
  pause: () => void;
  exportRecordedAudio: () => Blob | null;
  exportProtectedAudio: () => Blob | null;
  getCaptureSnapshot: () => CaptureSnapshot | null;
  subscribeCaptureStream: (fn: CaptureStreamListener) => () => void;
}
