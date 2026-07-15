/**
 * engine/core.ts — 엔진 공통 코어 (leaf 모듈)
 *
 * wasm-client-engine(adapters/wasm-client.ts)이 사용하는 기본 요소만 둔다.
 *   - 고정 프레임 포맷 상수
 *   - 스피커 프로파일(물리 모델) + 전력 스케일
 *   - 공통 Session/Frame 인터페이스
 *
 * 이 파일은 어댑터 구현을 import하지 않는 leaf 모듈이어야 한다(순환 의존 방지).
 * 스피커 프로파일은 후처리 보정에 쓰이는 공통 물리 모델이다.
 */

import type { EngineParams } from "../../types";

// ─── 프레임 포맷 ────────────────────────────────────────────────────────────
// CHANNELS/BYTES_PER_SAMPLE은 ABI 레벨 고정값(항상 스테레오 int16). SAMPLE_RATE/SAMPLES_PER_CH는 기본값일 뿐 고정이 아니다 — 세션마다 EngineRuntimeConfig로 재정의되어 ff_prot_start_exec의 dt 계산과 와이어 프레임 크기에 그대로 반영된다(Calibration UI → 다음 세션 시작 시 적용).
export const SAMPLE_RATE      = 48000;
export const CHANNELS         = 2;
export const BYTES_PER_SAMPLE = 2;
export const SAMPLES_PER_CH   = 480;

/** 세션 단위 런타임 프레임 설정 — Calibration UI의 sampleRate/bufferSize로 채워진다 */
export interface EngineRuntimeConfig {
  /** 샘플레이트 [Hz] — ff_prot_start_exec의 dt/LPF 계수 계산에 사용 */
  sampleRate: number;
  /** 채널당 샘플 수(버퍼 사이즈) — 와이어 프레임 크기 결정 */
  samplesPerCh: number;
}

export const DEFAULT_ENGINE_CONFIG: EngineRuntimeConfig = {
  sampleRate: SAMPLE_RATE,
  samplesPerCh: SAMPLES_PER_CH,
};

/** 주변 온도(°C) 기본값 — Calibration UI에서 미설정/파싱 실패 시 ff_prot_start_exec에 전달 */
export const DEFAULT_AMBIENT_TEMP = 25;

/** config 기준 프레임 바이트 크기 (samplesPerCh × CHANNELS × BYTES_PER_SAMPLE) */
export function frameBytes(config: EngineRuntimeConfig): number {
  return config.samplesPerCh * CHANNELS * BYTES_PER_SAMPLE;
}

// ─── 스피커 프로파일 ───
export interface SpeakerProfile {
  tempMult: number;  // 온도 승수 (1.0 = 기준)
  excMult:  number;  // 익스커션 승수
  tempBase: number;  // 온도 베이스 (°C)
  excAmp:   number;  // 익스커션 최대 진폭 (mm)
}

export const SPEAKER_PROFILES: Record<string, SpeakerProfile> = {
  "Z3 SPK": { tempMult: 1.00, excMult: 1.00, tempBase: 55, excAmp: 5.0 },
  "PA3 SPK": { tempMult: 0.82, excMult: 1.30, tempBase: 50, excAmp: 6.5 },
  "B7 SPK": { tempMult: 1.22, excMult: 0.65, tempBase: 63, excAmp: 3.2 },
  "R8 SPK": { tempMult: 0.74, excMult: 1.52, tempBase: 47, excAmp: 7.8 },
};

export const DEFAULT_PROFILE: SpeakerProfile = SPEAKER_PROFILES["Z3 SPK"];

const REF_AMP_POWER = 20; // W — 기준 전력

/** AMP 출력 전력 → 온도 승수 (열 평형: T ∝ P^0.6 근사) */
export function powerTempMult(watt: number | null): number {
  if (watt === null || watt <= 0) return 1.0;
  return Math.pow(watt / REF_AMP_POWER, 0.6);
}

// ─── 공통 분석 결과 인터페이스 ─────────────────────────────────────────────────
/** 엔진 분석 결과 */
export interface FrameResult {
  temperature:  [number, number];
  excursion:    [number, number];
  processingMs: number;
  /** 디버그용 raw 값 [T0, T1, E0, E1] — 필요 시만 포함 */
  raw?: [number, number, number, number];
}

// ─── 메모리 접근 추상화 ────────────────────────────────────────────────────────
/**
 * 엔진 메모리 접근 방식을 추상화하는 인터페이스
 * wasm-client 엔진: planar를 WASM 힙에 쓰고, bufPtr을 fnStartExec에 전달, 결과는 HEAP32에서 읽음
 * MemoryLayout은 이 접근 방식을 흡수하여 공통 분석 루프를 제공한다.
 */
export interface MemoryLayout {
  /** 임시 결과 버퍼 할당 (온도·익스커션용) */
  allocTemp(): { tempPtr: number; excPtr: number };
  /** PCM 버퍼 할당 (malloc 결과) */
  allocBuf(): number;
  /** 플래너 포맷 PCM을 메모리(HEAP)에 쓰기 */
  writePlanar(bufPtr: number, planar: Int16Array): void;
  /** ff_prot_start_exec 호출 (메모리 주소 또는 planar는 writePlanar에서 저장됨) */
  execAnalysis(bufPtr: number, tempPtr: number, excPtr: number, ambientTemp: number): void;
  /** 결과 버퍼(온도·익스커션)에서 값 읽기 → [T0, T1, E0, E1] */
  readResults(tempPtr: number, excPtr: number): [number, number, number, number];
  /** 할당된 메모리 해제 (free 호출) */
  free(ptrs: number[]): void;
}

// ─── 공통 분석 세션 인터페이스 ────────────────────────────────────────────────
/** AnalysisSession 구현체가 공통으로 따르는 분석 세션 인터페이스 */
export interface AnalysisSession {
  /** PCM 프레임 1개 분석 (deinterleave + 분석 + 후처리 보정) */
  analyze(pcm: Buffer | Uint8Array, params: EngineParams): FrameResult;
  /** 세션 종료 (메모리/리소스 해제) */
  close(): void;
}

