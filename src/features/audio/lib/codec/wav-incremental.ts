import { readTag, makeSampleReader } from "./wav-primitives";

export interface WavHeader {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
  durationSec: number;
}

const HEADER_BYTES = 44;

export async function peekWavHeader(blob: Blob): Promise<WavHeader | null> {
  if (blob.size < HEADER_BYTES) return null;
  const buf = await blob.slice(0, HEADER_BYTES).arrayBuffer();
  const view = new DataView(buf);
  if (readTag(view, 0) !== "RIFF" || readTag(view, 8) !== "WAVE" || readTag(view, 36) !== "data") return null;

  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataSize = view.getUint32(40, true);
  const bytesPerSample = bitsPerSample / 8;
  if (channels <= 0 || sampleRate <= 0 || bytesPerSample <= 0) return null;

  const frameCount = Math.floor(dataSize / (bytesPerSample * channels));
  return {
    channels, sampleRate, bitsPerSample,
    dataOffset: HEADER_BYTES,
    dataSize,
    durationSec: frameCount / sampleRate,
  };
}

export async function decodeWavRange(
  blob: Blob,
  header: WavHeader,
  channel: number,
  startSec: number,
  endSec: number,
): Promise<Float32Array> {
  const { channels, bitsPerSample, dataOffset, dataSize, sampleRate } = header;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = bytesPerSample * channels;
  const totalFrames = Math.floor(dataSize / blockAlign);

  const startFrame = Math.max(0, Math.min(totalFrames, Math.floor(startSec * sampleRate)));
  const endFrame = Math.max(startFrame, Math.min(totalFrames, Math.ceil(endSec * sampleRate)));
  if (endFrame <= startFrame) return new Float32Array(0);

  const byteStart = dataOffset + startFrame * blockAlign;
  const byteEnd = dataOffset + endFrame * blockAlign;
  const buf = await blob.slice(byteStart, byteEnd).arrayBuffer();
  const view = new DataView(buf);
  const read = makeSampleReader(view, bitsPerSample);
  if (!read) throw new Error(`지원하지 않는 bitsPerSample: ${bitsPerSample}`);

  const frameCount = Math.floor(buf.byteLength / blockAlign);
  const out = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) out[i] = read(i * blockAlign + channel * bytesPerSample);
  return out;
}

export function appendWindowed(existing: Float32Array, incoming: Float32Array, maxSamples: number): Float32Array {
  if (incoming.length === 0) return existing;
  const total = existing.length + incoming.length;
  if (total <= maxSamples) {
    const out = new Float32Array(total);
    out.set(existing, 0);
    out.set(incoming, existing.length);
    return out;
  }
  if (incoming.length >= maxSamples) return incoming.slice(incoming.length - maxSamples);
  const keepFromExisting = maxSamples - incoming.length;
  const out = new Float32Array(maxSamples);
  out.set(existing.subarray(existing.length - keepFromExisting), 0);
  out.set(incoming, keepFromExisting);
  return out;
}
