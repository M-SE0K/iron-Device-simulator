import { INT16_SCALE } from "@/features/audio/lib/engine/core";

export function readChannelFloat32(
  interleaved: Int16Array,
  channels: number,
  channel: number,
  out: Float32Array,
): void {
  const n = out.length;
  for (let i = 0; i < n; i++) {
    out[i] = interleaved[i * channels + channel] / INT16_SCALE;
  }
}

export function copyChannelFloat32(
  interleaved: Float32Array,
  channels: number,
  channel: number,
  startFrame: number,
  out: Float32Array,
): number {
  const totalFrames = Math.floor(interleaved.length / channels);
  const n = Math.max(0, Math.min(out.length, totalFrames - startFrame));
  for (let i = 0; i < n; i++) {
    out[i] = interleaved[(startFrame + i) * channels + channel];
  }
  return n;
}
