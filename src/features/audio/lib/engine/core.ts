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
// CHANNELS/BYTES_PER_SAMPLE은 ABI 레벨 고정값(항상 스테레오 int16). SAMPLE_RATE/SAMPLES_PER_CH는
// 기본값일 뿐 고정이 아니다 — 세션마다 EngineRuntimeConfig로 재정의된다(Calibration UI → 다음 세션 시작 시 적용). 단, ff_prot_start_exec는 검증된 실제 벤더 시그니처(sample_rate_hz 없음,
// VENDOR-API-SPEC.md 2.2절)를 따르므로 SAMPLES_PER_CH(samplesPerCh)만 그 호출 인자와 와이어 프레임 크기에 반영되고, SAMPLE_RATE는 WASM 엔진 호출에는 더 이상 전달되지 않는다(엔진 내부는
// 고정 DEFAULT_SAMPLE_RATE_HZ로 근사 — 알려진 한계, electron/native/wasm-engine/ff_prot.c 참고).
export const SAMPLE_RATE      = 48000;
export const CHANNELS         = 2;
export const BYTES_PER_SAMPLE = 2;
export const SAMPLES_PER_CH   = 480;

// ─── int16 PCM 경계 ────────────────────────────────────────────────────────
// 값이 인접하지만 쓰임이 다르다: 클램프는 int16 표현 가능 범위(MIN/MAX)를 쓰고,
// float 정규화(int16 -> [-1,1))는 제수 2^15(SCALE)를 쓴다. 섞어 쓰면 1LSB 어긋난다.
export const INT16_MAX   = 32767;
export const INT16_MIN   = -32768;
export const INT16_SCALE = 0x8000;

/**
 * 캡처 채널 수 하한 보정 — 엔진 분석은 ch0(V)/ch1(I) 두 채널을 반드시 요구하므로
 * 사용자 입력이 비었거나 2 미만이면 2로 끌어올린다.
 */
export function clampCaptureChannels(value: unknown): number {
  return Math.max(CHANNELS, Number(value) || CHANNELS);
}

/** 세션 단위 런타임 프레임 설정 — Calibration UI의 sampleRate/bufferSize로 채워진다 */
export interface EngineRuntimeConfig {
  /** 샘플레이트 [Hz] — 와이어/캡처 세션 설정용. ff_prot_start_exec에는 전달되지 않는다(실제
   * 벤더 시그니처에 sample_rate_hz가 없음, VENDOR-API-SPEC.md 2.2절). */
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

// 스피커 프로파일 승수(SPEAKER_PROFILES)와 전력 스케일(powerTempMult)은 2026-07-21 제거했다.
// 차트가 엔진 출력(spk_temp/spk_exc)을 그대로 표시하도록 바꾸면서 쓰는 곳이 없어졌다 —
// 모델별 보정이 다시 필요해지면 TS에서 곱하지 말고 ff_prot_set_param으로 엔진에 넘겨야 한다.
// (Calibration의 tempBase/excAmp/tempMult/excMult 입력 필드는 그 연동을 위한 선행 필드로 남아 있다.)

// ─── 공통 분석 결과 인터페이스 ─────────────────────────────────────────────────
/** 엔진 분석 결과 — temperature/excursion은 ff_prot_start_exec의 spk_temp/spk_exc 그대로다(보정 없음). */
export interface FrameResult {
  /** spk_temp[0..1] — 보이스코일 추정 온도 [°C] */
  temperature:  [number, number];
  /** spk_exc[0..1] — 콘 피크 변위 추정 [µm] (차트 표기만 units.ts의 toMm으로 mm 변환) */
  excursion:    [number, number];
  processingMs: number;
  /**
   * 보호 감쇠가 적용된 PCM (인터리브 int16, 입력과 동일한 프레임 크기) — 필요 시만 포함.
   * ff_prot_start_exec이 buf를 In/Out으로 쓰고 되돌려준 결과다(engine/README.md 참고).
   * ⚠️ 현재 엔진은 참조 스텁이라 감쇠 커브가 임의값이다 — 실제 보호 성능이 아니다.
   */
  processedPcm?: Int16Array;
}

// ─── 메모리 접근 추상화 ────────────────────────────────────────────────────────
/**
 * 엔진 메모리 접근 방식을 추상화하는 인터페이스
 * wasm-client 엔진: planar를 WASM 힙에 쓰고, bufPtr을 fnStartExec에 전달, 결과는 HEAP32에서 읽음
 * MemoryLayout은 이 접근 방식을 흡수하여 공통 분석 루프를 제공한다.
 */
/**
 * 실제 캡처된 V/I sensing 데이터 한 쌍 — ff_prot_start_exec의 v_sensing/i_sensing 인자로
 * 그대로 전달된다. 각각 samples_per_ch 길이의 단일(모노) 스트림이다 — buf처럼 channels별
 * 배열이 아니다. 디바이스 전체에 V/I 센스 라인이 하나뿐이라는 가정이며, 스피커별로 독립된
 * V/I 센싱이 있는 하드웨어라면 이 구조를 채널별 배열로 바꿔야 한다.
 *
 * 출처는 두 가지이고 local-socket.ts가 프레임 byteLength로 고른다:
 *   1) 4ch 이상 캡처의 전용 센싱 채널(reframeNativeChunk.ts의 SENSING_CHANNEL_INDEX)
 *   2) 없으면 분석 buf의 ch0(V)/ch1(I) — 이 경우 buf와 같은 샘플이다
 * ⚠️ 두 경로의 채널 배정 모두 이 캡처 파이프라인의 잠정 컨벤션이다 — 실제 하드웨어 배선은
 * 벤더/디바이스 문서로 확인해야 한다.
 */
export interface RealSensingPair {
  v: Int16Array;
  i: Int16Array;
}

export interface MemoryLayout {
  /** 임시 결과 버퍼 할당 (온도·익스커션용) */
  allocTemp(): { tempPtr: number; excPtr: number };
  /** PCM 버퍼 할당 (malloc 결과) */
  allocBuf(): number;
  /** 플래너 포맷 PCM을 메모리(HEAP)에 쓰기 */
  writePlanar(bufPtr: number, planar: Int16Array): void;
  /**
   * ff_prot_start_exec 호출 (메모리 주소 또는 planar는 writePlanar에서 저장됨).
   * sensing이 있으면 v_sensing/i_sensing 인자로 그 데이터를 넘긴다. 생략하면 NULL이 나가고
   * ff_prot.c가 PCM RMS 근사로 대체하지만, local-socket.ts는 항상 채워서 부른다 —
   * 근사로 조용히 떨어지는 경로를 남기지 않으려는 의도다(ff_prot.h 참고).
   */
  execAnalysis(bufPtr: number, tempPtr: number, excPtr: number, ambientTemp: number, sensing?: RealSensingPair): void;
  /** 결과 버퍼(온도·익스커션)에서 값 읽기 → [T0, T1, E0, E1] */
  readResults(tempPtr: number, excPtr: number): [number, number, number, number];
  /**
   * execAnalysis가 buf에 in-place로 되쓴 "보호 감쇠 적용 PCM"을 planar로 읽어온다.
   * 구현체는 반드시 **복사본**을 반환해야 한다 — WASM 힙 뷰를 그대로 넘기면
   * 다음 프레임에서 덮어써지고, 힙이 성장하면 detach되어 못 쓰게 된다.
   */
  readProcessedPcm(bufPtr: number, samplesPerCh: number): Int16Array;
  /** 할당된 메모리 해제 (free 호출) */
  free(ptrs: number[]): void;
}

// ─── 공통 분석 세션 인터페이스 ────────────────────────────────────────────────
/** AnalysisSession 구현체가 공통으로 따르는 분석 세션 인터페이스 */
export interface AnalysisSession {
  /**
   * PCM 프레임 1개 분석 (deinterleave + 분석 + 후처리 보정).
   * sensing: 네이티브 캡처가 함께 실어 보낸 실측 V/I sensing 데이터(있으면).
   */
  analyze(pcm: Buffer | Uint8Array, params: EngineParams, sensing?: RealSensingPair): FrameResult;
  /** 세션 종료 (메모리/리소스 해제) */
  close(): void;
}

