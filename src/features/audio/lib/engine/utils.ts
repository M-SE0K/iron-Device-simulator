import type { EngineParams } from "../../types";
import { round3 } from "@/shared/lib/utils";
import {
  CHANNELS, BYTES_PER_SAMPLE, INT16_MAX, INT16_MIN, frameBytes,
  type MemoryLayout, type FrameResult, type EngineRuntimeConfig, type RealSensingPair,
} from "./core";

export function encodeToInt16(ch0: Float32Array, ch1: Float32Array): Int16Array {
  const out = new Int16Array(ch0.length * 2);
  for (let i = 0; i < ch0.length; i++) {
    out[i * 2]     = Math.max(INT16_MIN, Math.min(INT16_MAX, Math.round(ch0[i] * INT16_MAX)));
    out[i * 2 + 1] = Math.max(INT16_MIN, Math.min(INT16_MAX, Math.round(ch1[i] * INT16_MAX)));
  }
  return out;
}

export function deinterleave(src: Buffer | Uint8Array, samplesPerCh: number): Int16Array {
  const dst = new Int16Array(samplesPerCh * CHANNELS);
  const channelOffsetSamples = samplesPerCh;

  // 프레임당 두 번 불리는 핫패스다 — DataView를 루프 안에서 만들면 샘플 수만큼 할당이 생긴다.
  const view = Buffer.isBuffer(src)
    ? null
    : new DataView(src.buffer, src.byteOffset, src.byteLength);

  for (let ch = 0; ch < CHANNELS; ch++) {
    for (let i = 0; i < samplesPerCh; i++) {
      const srcOff = (i * CHANNELS + ch) * BYTES_PER_SAMPLE;
      dst[ch * channelOffsetSamples + i] = view
        ? view.getInt16(srcOff, true)
        : (src as Buffer).readInt16LE(srcOff);
    }
  }

  return dst;
}

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

export interface AnalysisFrameOptions {
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
    const [temperature, excursion] = layout.readResults(tempPtr, excPtr);

    const processedPcm = opts.includeProcessedPcm
      ? interleaveFromPlanar(layout.readProcessedPcm(bufPtr, config.samplesPerCh), config.samplesPerCh)
      : undefined;

    return {
      temperature,
      excursion,
      processingMs: round3(performance.now() - t0),
      ...(processedPcm && { processedPcm }),
    };
  } finally {
    layout.free([bufPtr, tempPtr, excPtr]);
  }
}
