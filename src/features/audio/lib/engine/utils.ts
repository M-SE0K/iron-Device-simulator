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

  const isBuffer = Buffer.isBuffer(src);

  for (let ch = 0; ch < CHANNELS; ch++) {
    for (let i = 0; i < samplesPerCh; i++) {
      const srcOff = (i * CHANNELS + ch) * BYTES_PER_SAMPLE;
      let sample: number;

      if (isBuffer) {
        sample = (src as Buffer).readInt16LE(srcOff);
      } else {
        const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
        sample = view.getInt16(srcOff, true);
      }

      dst[ch * channelOffsetSamples + i] = sample;
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
    const tExec0 = performance.now();
    layout.execAnalysis(bufPtr, tempPtr, excPtr, params.ambientTemp, sensing);
    const execMs = performance.now() - tExec0;
    const [temp0, temp1, exc0, exc1] = layout.readResults(tempPtr, excPtr);

    const processedPcm = opts.includeProcessedPcm
      ? interleaveFromPlanar(layout.readProcessedPcm(bufPtr, config.samplesPerCh), config.samplesPerCh)
      : undefined;

    return {
      temperature: [temp0, temp1],
      excursion: [exc0, exc1],
      processingMs: round3(performance.now() - t0),
      execMs: round3(execMs),
      ...(processedPcm && { processedPcm }),
    };
  } finally {
    layout.free([bufPtr, tempPtr, excPtr]);
  }
}
