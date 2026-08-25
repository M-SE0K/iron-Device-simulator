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
  /** 온도 한계(°C) — 이벤트 감지·온도 차트 임계선의 단일 임계값 */
  tmax: string;
  /** 변위 한계(mm) — 변위 차트 임계선 */
  xmax: string;
}

/** 스피커 이상 상태 — 온도 가드가 잡아내는 두 방향의 발산.
 *  "open"  : 온도 ≥ TEMP_OVERFLOW_LIMIT_C  (열모델 발산 / 스피커 단선)
 *  "short" : 온도 ≤ TEMP_SHORT_LIMIT_C     (음수 폭주 / 스피커 단락)
 *  둘 다 프레임 단위 상태다 — 온도가 정상 범위로 돌아오면 그 프레임부터 null 이 된다. */
export type SpeakerFault = "open" | "short";

export interface AnalysisFrame {
  time: number;
  temperature: number;
  excursion: number;
  excursionMin?: number;
  excursionMax?: number;
  temperatureMax?: number;
  isEvent?: boolean;
  /** 이 프레임이 온도 가드에 걸렸는지. 걸린 프레임의 temperature/excursion 은 이미 0 으로
   *  깔려 있어 값만으로는 되짚을 수 없으므로, 표시 계층(ChartStore)이 이 플래그로 판단한다. */
  speakerFault?: SpeakerFault | null;
}

export type AppStatus =
  | "idle"
  | "ready"
  | "playing"
  | "paused"
  | "error";


export type EngineMessage =
  | { type: "ready"; warmupDroppedFrames?: number }
  | { type: "frame"; frameIndex: number; time: number; temperature: number; excursion: number; processingMs: number; speakerFault?: SpeakerFault | null }
  | { type: "error"; message: string };

export type EngineFrameMessage = Extract<EngineMessage, { type: "frame" }>;
