import type { EngineParams } from "../../types";

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

/* 스피커 온도 발산 가드 — 이 값(°C) 이상이 나오면 열모델이 터진 것으로 보고 해당 프레임의
 * 온도/변위를 둘 다 0 으로 깐다. 엔진 출력(wasm-client)과 차트 입력(ChartStore) 양쪽에서
 * 같은 조건을 쓰기 위해 여기(leaf 모듈)에 둔다. */
export const TEMP_OVERFLOW_LIMIT_C = 500;

export function isTempOverflow(temperature: number): boolean {
  return temperature >= TEMP_OVERFLOW_LIMIT_C;
}

export function frameBytes(config: EngineRuntimeConfig): number {
  return config.samplesPerCh * CHANNELS * BYTES_PER_SAMPLE;
}


export interface FrameResult {
  temperature:  number;
  excursion:    number;
  processingMs: number;
  processedPcm: Int16Array;
  /** 이 프레임이 `TEMP_OVERFLOW_LIMIT_C` 가드에 걸려 0 으로 깔렸는지. 값 자체는 이미 0 이라
   *  downstream 이 되짚을 방법이 없어서 별도 플래그로 들려 보낸다(스피커 open 팝업 트리거). */
  tempOverflow: boolean;
}

export interface RealSensingPair {
  v: Int16Array;
  i: Int16Array;
}

export interface AnalysisSession {
  analyze(pcm: Uint8Array, params: EngineParams, sensing?: RealSensingPair): FrameResult;
  close(): void;
}

