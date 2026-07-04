/**
 * engine/utils.ts — 공유 분석 유틸 (deinterleave, 후처리 보정)
 *
 * native-engine / wasm-engine / wasm-client-engine에서 중복되던
 * PCM 변환과 SPEAKER_PROFILES 후처리 보정을 통합한다.
 */

import type { EngineParams } from "../../types";
import {
  SAMPLES_PER_CH, CHANNELS, BYTES_PER_SAMPLE, FRAME_BYTES,
  SPEAKER_PROFILES, DEFAULT_PROFILE, powerTempMult,
  type MemoryLayout, type FrameResult,
} from "./core";

// ─── PCM 변환: 인터리브(L R L R) → 플래너(LL...RR...) ────────────────────────
/**
 * 인터리브 PCM을 플래너 형식으로 변환한다.
 * Buffer, Int16Array 등 다양한 입력 타입 지원.
 */
export function deinterleave(src: Buffer | Uint8Array): Int16Array {
  const dst = new Int16Array(SAMPLES_PER_CH * CHANNELS);
  const channelOffsetSamples = SAMPLES_PER_CH;

  // Buffer와 Uint8Array 모두 getInt16/readInt16LE 호환 처리
  const isBuffer = Buffer.isBuffer(src);

  for (let ch = 0; ch < CHANNELS; ch++) {
    for (let i = 0; i < SAMPLES_PER_CH; i++) {
      const srcOff = (i * CHANNELS + ch) * BYTES_PER_SAMPLE;
      let sample: number;

      if (isBuffer) {
        sample = (src as Buffer).readInt16LE(srcOff);
      } else {
        const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
        sample = view.getInt16(srcOff, true); // true = littleEndian
      }

      dst[ch * channelOffsetSamples + i] = sample;
    }
  }

  return dst;
}

// ─── 프레임 분석 결과 후처리 보정 ──────────────────────────────────────────────
/**
 * libirontune.so / WASM 엔진에서 나온 raw 분석 값에 스피커 프로파일 및
 * 전력 스케일을 적용하여 최종 값을 계산한다.
 *
 * ff_prot_set_param이 NOP인 동안의 임시 규약이며, 정품 라이브러리에서
 * 직접 지원하면 폐기된다.
 */
export interface PostCorrectionResult {
  temperature: [number, number];
  excursion: [number, number];
  raw?: [number, number, number, number]; // [rawTemp0, rawTemp1, rawExc0, rawExc1]
}

export function applyPostCorrection(
  rawTemp0: number,
  rawTemp1: number,
  rawExc0: number,
  rawExc1: number,
  params: EngineParams,
  includeRaw?: boolean,
): PostCorrectionResult {
  const profile = SPEAKER_PROFILES[params.speakerModel] ?? DEFAULT_PROFILE;
  const pwrScale = powerTempMult(params.ampOutputPower);

  const temperature: [number, number] = [
    Math.round(rawTemp0 * profile.tempMult * pwrScale),
    Math.round(rawTemp1 * profile.tempMult * pwrScale),
  ];
  const excursion: [number, number] = [
    Math.round(rawExc0 * profile.excMult),
    Math.round(rawExc1 * profile.excMult),
  ];

  return {
    temperature,
    excursion,
    ...(includeRaw && { raw: [rawTemp0, rawTemp1, rawExc0, rawExc1] }),
  };
}

// ─── 엔진 독립적 분석 헬퍼 ──────────────────────────────────────────────────────
/**
 * MemoryLayout을 사용한 엔진 독립적 프레임 분석.
 * deinterleave부터 applyPostCorrection까지 전체 파이프라인을 담당한다.
 * native-engine / wasm-engine / wasm-client-engine의 analyze() 중복을 제거한다.
 */
export function createAnalysisFrame(
  pcm: Buffer | Uint8Array,
  params: EngineParams,
  layout: MemoryLayout,
  includeRaw: boolean = false,
): FrameResult {
  const t0 = performance.now();

  const planar = deinterleave(pcm.subarray(0, FRAME_BYTES));
  const { tempPtr, excPtr } = layout.allocTemp();
  const bufPtr = layout.allocBuf();

  try {
    layout.writePlanar(bufPtr, planar);
    layout.execAnalysis(bufPtr, tempPtr, excPtr);
    const [rawTemp0, rawTemp1, rawExc0, rawExc1] = layout.readResults(tempPtr, excPtr);

    const { temperature, excursion, raw } = applyPostCorrection(
      rawTemp0, rawTemp1, rawExc0, rawExc1,
      params,
      includeRaw,
    );

    return {
      temperature,
      excursion,
      processingMs: parseFloat((performance.now() - t0).toFixed(3)),
      ...(raw && { raw }),
    };
  } finally {
    layout.free([bufPtr, tempPtr, excPtr]);
  }
}
