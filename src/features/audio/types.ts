export interface EngineParams {
  ampOutputPower: number | null;
  speakerModel: string;
  ambientTemp: number;
}

export interface InputParameterValues {
  ampOutputPower: string;
  speakerModel: string;
  ambientTemp: string;
}

export interface CalibrationValues {
  speakerModel: string;
  ampOutputPower: string;
  ambientTemp: string;
  sampleRate: string;
  bufferSize: string;
  channels: string;
  inputDeviceId: string;
  inputDeviceLabel: string;
  captureDeviceUID: string;
  outputDeviceId: string;
  outputDeviceLabel: string;
  outputChannel: string;
  tempBase: string;
  excAmp: string;
  tempMult: string;
  excMult: string;
  tempWarn: string;
  tempDanger: string;
}

export interface AnalysisFrame {
  time: number;
  temperature: number;
  excursion: number;
  sourceCount?: number;
  timeStart?: number;
  timeEnd?: number;
  excursionMin?: number;
  excursionMax?: number;
  temperatureMax?: number;
  isEvent?: boolean;
  eventType?: "temp_warn" | "temp_danger" | "exc_peak";
}

export type AppStatus =
  | "idle"
  | "uploading"
  | "analyzing"
  | "ready"
  | "playing"
  | "paused"
  | "error";


export type WsServerMessage =
  // warmupDroppedFrames: 엔진(WASM) 로드가 끝나기 전에 도착해 분석하지 못한 프레임 수.
  // 재생은 그동안에도 흘러가므로 이 값 × samplesPerCh / sampleRate 초만큼이 "측정 결과가
  // 비어 있는 앞구간"이다 — 플랫폼별 워밍업 비용을 재는 계측치.
  | { type: "ready"; warmupDroppedFrames?: number }
  | { type: "frame"; frameIndex: number; time: number; temperature: number; excursion: number; processingMs: number; engineExecMs?: number }
  | { type: "error"; message: string };
