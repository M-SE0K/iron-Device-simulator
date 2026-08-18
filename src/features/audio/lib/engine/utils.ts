import { CHANNELS, BYTES_PER_SAMPLE, INT16_MAX, INT16_MIN } from "./core";

export function encodeToInt16(ch0: Float32Array, ch1: Float32Array): Int16Array {
  const out = new Int16Array(ch0.length * 2);
  for (let i = 0; i < ch0.length; i++) {
    out[i * 2]     = Math.max(INT16_MIN, Math.min(INT16_MAX, Math.round(ch0[i] * INT16_MAX)));
    out[i * 2 + 1] = Math.max(INT16_MIN, Math.min(INT16_MAX, Math.round(ch1[i] * INT16_MAX)));
  }
  return out;
}

export function deinterleave(src: Uint8Array, samplesPerCh: number): Int16Array {
  const dst = new Int16Array(samplesPerCh * CHANNELS);
  const channelOffsetSamples = samplesPerCh;

  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);

  for (let ch = 0; ch < CHANNELS; ch++) {
    for (let i = 0; i < samplesPerCh; i++) {
      const srcOff = (i * CHANNELS + ch) * BYTES_PER_SAMPLE;
      dst[ch * channelOffsetSamples + i] = view.getInt16(srcOff, true);
    }
  }

  return dst;
}
