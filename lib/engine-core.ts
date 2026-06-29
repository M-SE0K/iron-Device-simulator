/**
 * engine-core.ts — 엔진 공통 코어 (leaf 모듈)
 *
 * mock-engine / native-engine 양쪽이 공유하는 기본 요소만 둔다.
 *   - 고정 프레임 포맷 상수
 *   - 스피커 프로파일(물리 모델) + 전력 스케일
 *
 * 이 파일은 mock/native 어느 쪽도 import하지 않는 leaf 모듈이어야 한다
 * (순환 의존 방지). 스피커 프로파일은 native 후처리 보정과 mock 곡선 합성에
 * 모두 쓰이는 공통 물리 모델이다.
 */

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
  tempBase: number;  // mock 기준 온도 베이스 (°C)
  excAmp:   number;  // mock 기준 익스커션 최대 진폭 (mm)
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
