/**
 * engine/core.ts — 엔진 공통 코어 (leaf 모듈)
 *
 * native-engine / wasm-engine / wasm-client-engine이 공유하는 기본 요소만 둔다.
 *   - 고정 프레임 포맷 상수
 *   - 스피커 프로파일(물리 모델) + 전력 스케일
 *   - 공통 Session/Frame 인터페이스
 *
 * 이 파일은 native/wasm 어느 쪽도 import하지 않는 leaf 모듈이어야 한다
 * (순환 의존 방지). 스피커 프로파일은 native/wasm 후처리 보정에
 * 쓰이는 공통 물리 모델이다.
 */

import type { EngineParams } from "../../types";

// ─── 고정 프레임 포맷 ────────────────────────────────────────────────────────
// 480 samples/ch × 2 ch × 2 bytes(int16) = 1920 bytes/frame, 48 kHz 인터리브(L R L R)
export const SAMPLE_RATE      = 48000;
export const CHANNELS         = 2;
export const BYTES_PER_SAMPLE = 2;
export const SAMPLES_PER_CH   = 480;
export const FRAME_BYTES      = SAMPLES_PER_CH * CHANNELS * BYTES_PER_SAMPLE; // 1920

// ─── 스피커 프로파일 (so_report.md 기반 물리 모델) ───────────────────────────
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
/** 엔진 분석 결과 (native-engine / wasm-engine / wasm-client-engine 공통) */
export interface FrameResult {
  temperature:  [number, number];
  excursion:    [number, number];
  processingMs: number;
  /** 디버그용 raw 값 [T0, T1, E0, E1] — 필요 시만 포함 */
  raw?: [number, number, number, number];
}

// ─── 메모리 접근 추상화 ────────────────────────────────────────────────────────
/**
 * 엔진별 메모리 접근 방식을 추상화하는 인터페이스 (native/wasm 버퍼 차이 흡수)
 *
 * native 엔진:  fnStartExec에 planar를 직접 전달, 결과는 Buffer에서 읽음
 * wasm 엔진:    planar를 WASM 힙에 쓰고, bufPtr을 fnStartExec에 전달, 결과는 HEAP32에서 읽음
 *
 * MemoryLayout은 이 차이를 흡수하여 공통 분석 루프를 제공한다.
 */
export interface MemoryLayout {
  /** 임시 결과 버퍼 할당 (온도·익스커션용) */
  allocTemp(): { tempPtr: number; excPtr: number };
  /** PCM 버퍼 할당 (native는 0 반환, wasm은 malloc 결과) */
  allocBuf(): number;
  /** 플래너 포맷 PCM을 메모리에 쓰기 (native는 저장만, wasm은 HEAP에 쓰기) */
  writePlanar(bufPtr: number, planar: Int16Array): void;
  /** ff_prot_start_exec 호출 (메모리 주소 또는 planar는 writePlanar에서 저장됨) */
  execAnalysis(bufPtr: number, tempPtr: number, excPtr: number): void;
  /** 결과 버퍼(온도·익스커션)에서 값 읽기 → [T0, T1, E0, E1] */
  readResults(tempPtr: number, excPtr: number): [number, number, number, number];
  /** 할당된 메모리 해제 (native는 자동 GC, wasm은 free 호출) */
  free(ptrs: number[]): void;
}

// ─── 공통 분석 세션 인터페이스 ────────────────────────────────────────────────
/** 모든 엔진(native/wasm/wasm-client)이 구현하는 공통 분석 세션 인터페이스 */
export interface AnalysisSession {
  /** PCM 프레임 1개 분석 (deinterleave + 분석 + 후처리 보정) */
  analyze(pcm: Buffer | Uint8Array, params: EngineParams): FrameResult;
  /** 세션 종료 (메모리/리소스 해제) */
  close(): void;
}

