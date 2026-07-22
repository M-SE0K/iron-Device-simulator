/**
 * engine/utils.ts — 공유 분석 유틸 (PCM 인터리브<->플래너 변환, 프레임 분석 파이프라인)
 *
 * 차트에 그려지는 온도/변위는 ff_prot_start_exec이 spk_temp/spk_exc 포인터에 써 준 값
 * 그대로다 — 스피커 프로파일 승수나 전력 스케일 같은 TS측 후처리 보정은 적용하지 않는다
 * (2026-07-21 제거). 모델별 보정이 필요하면 엔진이 ff_prot_set_param으로 받아 내부에서
 * 반영해야 한다.
 */

import type { EngineParams } from "../../types";
import { round3 } from "@/shared/lib/utils";
import {
  CHANNELS, BYTES_PER_SAMPLE, INT16_MAX, INT16_MIN, frameBytes,
  type MemoryLayout, type FrameResult, type EngineRuntimeConfig, type RealSensingPair,
} from "./core";

// ─── PCM 변환: 플래너(Float32, ch0/ch1) → 인터리브 Int16(L R L R) ────────────
/**
 * 마이크/파일 캡처의 플래너 Float32 채널 쌍을 분석 소켓 전송용 인터리브 형태를 Int16 PCM으로 변환한다 (WaveformPlayer/MicrophonePlayer 공용).
 */
export function encodeToInt16(ch0: Float32Array, ch1: Float32Array): Int16Array {
  const out = new Int16Array(ch0.length * 2);
  for (let i = 0; i < ch0.length; i++) {
    out[i * 2]     = Math.max(INT16_MIN, Math.min(INT16_MAX, Math.round(ch0[i] * INT16_MAX)));
    out[i * 2 + 1] = Math.max(INT16_MIN, Math.min(INT16_MAX, Math.round(ch1[i] * INT16_MAX)));
  }
  return out;
}

// ─── PCM 변환: 인터리브(L R L R) → 플래너(LL...RR...) ────────────────────────
/**
 * 인터리브 PCM을 플래너 형식으로 변환한다.
 * Buffer, Uint8Array 등 다양한 입력 타입 지원.
 */
export function deinterleave(src: Buffer | Uint8Array, samplesPerCh: number): Int16Array {
  const dst = new Int16Array(samplesPerCh * CHANNELS);
  const channelOffsetSamples = samplesPerCh;

  // Buffer와 Uint8Array 모두 getInt16/readInt16LE 호환 처리
  const isBuffer = Buffer.isBuffer(src);

  for (let ch = 0; ch < CHANNELS; ch++) {
    for (let i = 0; i < samplesPerCh; i++) {
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

// ─── PCM 변환: 플래너(LL...RR...) → 인터리브(L R L R) ────────────────────────
/**
 * deinterleave()의 역변환. ff_prot_start_exec이 buf에 in-place로 되쓴 planar 결과를
 * 재생/저장용 인터리브 PCM으로 복원한다 — 벤더 래퍼(../irondevice/ff_prot.c)가 exec 직후
 * 하는 복사와 같은 역할이다.
 */
function interleaveFromPlanar(planar: Int16Array, samplesPerCh: number): Int16Array {
  const out = new Int16Array(samplesPerCh * CHANNELS);
  for (let ch = 0; ch < CHANNELS; ch++) {
    const base = ch * samplesPerCh;
    for (let i = 0; i < samplesPerCh; i++) {
      out[i * CHANNELS + ch] = planar[base + i];
    }
  }
  return out;
}

// ─── 엔진 독립적 분석 헬퍼 ──────────────────────────────────────────────────────
/**
 * MemoryLayout을 사용한 엔진 독립적 프레임 분석.
 * deinterleave → execAnalysis → 결과 읽기까지의 전체 파이프라인을 담당한다.
 */
export interface AnalysisFrameOptions {
  /**
   * 보호 감쇠가 적용된 PCM을 결과에 포함. 프레임마다 Int16Array 두 개(planar 복사 +
   * 인터리브 복원)를 새로 만들므로, 실제로 쓰는 소비자가 있을 때만 켠다.
   */
  includeProcessedPcm?: boolean;
}

export function createAnalysisFrame(
  pcm: Buffer | Uint8Array,
  params: EngineParams,
  layout: MemoryLayout,
  config: EngineRuntimeConfig,
  opts: AnalysisFrameOptions = {},
  sensing?: RealSensingPair,
): FrameResult {
  const t0 = performance.now();

  const planar = deinterleave(pcm.subarray(0, frameBytes(config)), config.samplesPerCh);
  const { tempPtr, excPtr } = layout.allocTemp();
  const bufPtr = layout.allocBuf();

  try {
    layout.writePlanar(bufPtr, planar);
    layout.execAnalysis(bufPtr, tempPtr, excPtr, params.ambientTemp, sensing);
    // spk_temp[2] / spk_exc[2]를 그대로 쓴다 — 엔진이 이미 정수로 내보내므로 반올림도 없다.
    // 단위: 온도 °C, 변위 µm(차트에서 units.ts의 toMm으로 mm 표기).
    const [temp0, temp1, exc0, exc1] = layout.readResults(tempPtr, excPtr);

    // buf는 In/Out이라 이 시점의 bufPtr 내용은 입력이 아니라 "감쇠가 적용된 출력"이다.
    const processedPcm = opts.includeProcessedPcm
      ? interleaveFromPlanar(layout.readProcessedPcm(bufPtr, config.samplesPerCh), config.samplesPerCh)
      : undefined;

    return {
      temperature: [temp0, temp1],
      excursion: [exc0, exc1],
      processingMs: round3(performance.now() - t0),
      ...(processedPcm && { processedPcm }),
    };
  } finally {
    layout.free([bufPtr, tempPtr, excPtr]);
  }
}
