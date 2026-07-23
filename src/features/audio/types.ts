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
  temperature: [number, number];
  excursion: [number, number];
  sourceCount?: number;
  timeStart?: number;
  timeEnd?: number;
  excursionMin?: [number, number];
  excursionMax?: [number, number];
  temperatureMax?: [number, number];
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
  | { type: "ready" }
  | { type: "frame"; frameIndex: number; time: number; temperature: [number, number]; excursion: [number, number]; processingMs: number; engineExecMs?: number }
  | { type: "error"; message: string };
