import type { CalibrationValues, TuningParamKey, TuningParams } from "@/features/audio/types";
import { DEFAULT_AMBIENT_TEMP, SAMPLE_RATE, SAMPLES_PER_CH } from "@/features/audio/lib/engine/core";
import { DEFAULT_TMAX, DEFAULT_XMAX } from "@/features/audio/lib/render/detect-events";

export const SAMPLE_RATE_OPTIONS = ["8000", "11025", "16000", "32000", "44100", "48000", "96000", "176400", "192000", "352800", "384000"];
export const BUFFER_SIZE_OPTIONS = ["8", "16", "32", "64", "128", "256", "480", "512", "1024", "2048"];
export const CHANNEL_OPTIONS = ["2", "4", "6", "8"];

/* ── 스피커 튜닝 파라미터 (Thiele-Small) ─────────────────────────────────────
 * 항목 집합은 코드에 고정이고 사용자는 값만 바꾼다 — 드로어가 아래 표를 그대로 렌더하므로
 * 추가/삭제 UI 자체가 존재하지 않는다. 항목을 늘리려면 types.ts 의 TuningParamKey 와
 * 아래 두 상수를 함께 고쳐야 한다(기본값 레코드는 TS 가 누락을 잡아준다).
 *
 * ⚠️ 현재 이 값들은 저장·표시 전용이다. 벤더 ABI(ff_prot.h)에 이걸 받을 자리가 없다 —
 * ff_prot_set_param 은 인자가 없고 ff_prot_start_exec 9개 인자에도 해당 항목이 없다.
 * 엔진에 전달할 통로가 생기면 그때 연결한다. */
export const TUNING_PARAM_DEFAULTS: TuningParams = {
  re:  "6.25",
  le:  "0.069",
  fs:  "611",
  mms: "0.200",
  rms: "0.398",
  cms: "0.338",
  kms: "2.960",
  bl:  "1.075",
  qts: "1.323",
};

export interface TuningParamField {
  key: TuningParamKey;
  label: string;
  unit?: string;
  /** number input 의 step — 기본값이 가진 소수 자릿수에 맞춘다 */
  step: string;
}

/** 드로어에 표시되는 순서 그대로 */
export const TUNING_PARAM_FIELDS: readonly TuningParamField[] = [
  { key: "re",  label: "Re",  unit: "Ω",    step: "0.01"  },
  { key: "le",  label: "Le",  unit: "mH",   step: "0.001" },
  { key: "fs",  label: "fs",  unit: "Hz",   step: "1"     },
  { key: "mms", label: "Mms", unit: "g",    step: "0.001" },
  { key: "rms", label: "Rms", unit: "kg/s", step: "0.001" },
  { key: "cms", label: "Cms", unit: "mm/N", step: "0.001" },
  { key: "kms", label: "Kms", unit: "N/mm", step: "0.001" },
  { key: "bl",  label: "Bl",  unit: "N/A",  step: "0.001" },
  { key: "qts", label: "Qts",               step: "0.001" },
];

export const CALIBRATION_EMPTY: CalibrationValues = {
  ...TUNING_PARAM_DEFAULTS,
  ambientTemp: String(DEFAULT_AMBIENT_TEMP),
  sampleRate: String(SAMPLE_RATE),
  bufferSize: String(SAMPLES_PER_CH),
  channels: "2",
  captureDeviceUID: "",
  outputChannel: "0",
  tmax: String(DEFAULT_TMAX),
  xmax: String(DEFAULT_XMAX),
};
