import type { EngineParams, SpeakerFault } from "../../types";

export const SAMPLE_RATE      = 48000;
export const CHANNELS         = 2;
/* 분석 프레임의 채널 규약 — ch0 = V(전압 센스), ch1 = I(전류 센스). 캡처가 더 많은 채널을
 * 열어도 이 두 개의 의미는 고정이다. */
export const VOLTAGE_CHANNEL  = 0;
export const CURRENT_CHANNEL  = 1;
export const BYTES_PER_SAMPLE = 2;
export const SAMPLES_PER_CH   = 480;

export const INT16_MAX   = 32767;
export const INT16_MIN   = -32768;
export const INT16_SCALE = 0x8000;

export function clampCaptureChannels(value: unknown): number {
  return Math.max(CHANNELS, Number(value) || CHANNELS);
}

export interface EngineRuntimeConfig {
  sampleRate: number;
  samplesPerCh: number;
}

export const DEFAULT_ENGINE_CONFIG: EngineRuntimeConfig = {
  sampleRate: SAMPLE_RATE,
  samplesPerCh: SAMPLES_PER_CH,
};

export const DEFAULT_AMBIENT_TEMP = 25;

/* 스피커 온도 발산 가드 — 이 범위를 벗어나면 열모델이 터진 것으로 보고 해당 프레임의
 * 온도/변위를 둘 다 0 으로 깔고, 어느 쪽으로 터졌는지를 SpeakerFault 로 들려 보낸다.
 * 엔진 출력(wasm-client)과 차트 입력(ChartStore) 양쪽에서 같은 조건을 쓰기 위해
 * 여기(leaf 모듈)에 둔다. */
export const TEMP_OVERFLOW_LIMIT_C = 500;
export const TEMP_SHORT_LIMIT_C = -500;

export function detectSpeakerFault(temperature: number): SpeakerFault | null {
  if (!Number.isFinite(temperature)) return null;
  if (temperature >= TEMP_OVERFLOW_LIMIT_C) return "open";
  if (temperature <= TEMP_SHORT_LIMIT_C) return "short";
  return null;
}

export function frameBytes(config: EngineRuntimeConfig): number {
  return config.samplesPerCh * CHANNELS * BYTES_PER_SAMPLE;
}


export interface FrameResult {
  temperature:  number;
  excursion:    number;
  processingMs: number;
  processedPcm: Int16Array;
  /** 이 프레임이 온도 가드에 걸려 0 으로 깔렸는지, 걸렸다면 어느 방향인지. 값 자체는 이미
   *  0 이라 downstream 이 되짚을 방법이 없어서 별도 플래그로 들려 보낸다. 프레임 단위라
   *  온도가 정상으로 돌아오면 그 프레임부터 null 이다(경고 해제의 근거). */
  speakerFault: SpeakerFault | null;
}

export interface RealSensingPair {
  v: Int16Array;
  i: Int16Array;
}

export interface AnalysisSession {
  analyze(pcm: Uint8Array, params: EngineParams, sensing?: RealSensingPair): FrameResult;
  close(): void;
}

