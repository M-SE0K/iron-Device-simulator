export interface EngineParams {
  ambientTemp: number;
}

export type InputParameterValues = Pick<CalibrationValues, "ambientTemp">;

export interface CalibrationValues {
  ambientTemp: string;
  sampleRate: string;
  bufferSize: string;
  channels: string;
  captureDeviceUID: string;
  outputChannel: string;
  tempWarn: string;
  tempDanger: string;
}

export interface AnalysisFrame {
  time: number;
  temperature: number;
  excursion: number;
  excursionMin?: number;
  excursionMax?: number;
  temperatureMax?: number;
  isEvent?: boolean;
}

export type AppStatus =
  | "idle"
  | "ready"
  | "playing"
  | "paused"
  | "error";


export type EngineMessage =
  | { type: "ready"; warmupDroppedFrames?: number }
  | { type: "frame"; frameIndex: number; time: number; temperature: number; excursion: number; processingMs: number; tempOverflow?: boolean }
  | { type: "error"; message: string };

export type EngineFrameMessage = Extract<EngineMessage, { type: "frame" }>;
