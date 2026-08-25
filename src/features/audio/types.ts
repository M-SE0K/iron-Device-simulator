export interface EngineParams {
  ambientTemp: number;
}

export type InputParameterValues = Pick<CalibrationValues, "ambientTemp">;

/** 스피커 튜닝 파라미터(Thiele-Small) 키 — **집합이 여기 고정**이다.
 *  사용자는 값만 바꿀 수 있고 항목을 추가·삭제하는 경로는 UI에 없다.
 *  라벨/단위/기본값은 calibration-options.ts 의 TUNING_PARAM_* 가 갖는다. */
export type TuningParamKey =
  | "re"    /* Ω    직류 저항            */
  | "le"    /* mH   보이스코일 인덕턴스   */
  | "fs"    /* Hz   자유공진 주파수      */
  | "mms"   /* g    진동계 유효질량      */
  | "rms"   /* kg/s 기계 손실 저항       */
  | "cms"   /* mm/N 기계 컴플라이언스     */
  | "kms"   /* N/mm 기계 강성 (=1/Cms)   */
  | "bl"    /* N/A  힘 계수             */
  | "qts";  /*      종합 Q              */

/** 문자열로 들고 있는 이유는 나머지 Calibration 필드와 같다 — 입력 중간 상태(빈 문자열,
 *  "0." 등)를 그대로 보존해야 해서 숫자 변환은 소비 시점에 한다. */
export type TuningParams = Record<TuningParamKey, string>;

export interface CalibrationValues extends TuningParams {
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
