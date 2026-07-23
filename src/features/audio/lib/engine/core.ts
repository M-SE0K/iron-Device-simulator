import type { EngineParams } from "../../types";

export const SAMPLE_RATE      = 48000;
export const CHANNELS         = 2;
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

export function frameBytes(config: EngineRuntimeConfig): number {
  return config.samplesPerCh * CHANNELS * BYTES_PER_SAMPLE;
}


export interface FrameResult {
  temperature:  [number, number];
  excursion:    [number, number];
  processingMs: number;
  // processingMs 중 execAnalysis(엔진 호출) 구간만 분리한 값 — E2E 지연 실험(N5/N6) 전용,
  // src/features/audio/lib/perf-e2e/ 참고.
  execMs?: number;
  processedPcm?: Int16Array;
}

export interface RealSensingPair {
  v: Int16Array;
  i: Int16Array;
}

export interface MemoryLayout {
  allocTemp(): { tempPtr: number; excPtr: number };
  allocBuf(): number;
  writePlanar(bufPtr: number, planar: Int16Array): void;
  execAnalysis(bufPtr: number, tempPtr: number, excPtr: number, ambientTemp: number, sensing?: RealSensingPair): void;
  readResults(tempPtr: number, excPtr: number): [number, number, number, number];
  readProcessedPcm(bufPtr: number, samplesPerCh: number): Int16Array;
  free(ptrs: number[]): void;
}

export interface AnalysisSession {
  analyze(pcm: Buffer | Uint8Array, params: EngineParams, sensing?: RealSensingPair): FrameResult;
  close(): void;
}

