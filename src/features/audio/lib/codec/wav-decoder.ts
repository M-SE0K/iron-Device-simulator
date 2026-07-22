import { readTag, makeSampleReader } from "./wav-primitives";

export interface DecodedChannels {
  channels: Float32Array[];
  sampleRate: number;
  durationSec: number;
}

function parseWav(buf: ArrayBuffer): DecodedChannels | null {
  const view = new DataView(buf);
  if (buf.byteLength < 44) return null;
  const tag = (off: number) => readTag(view, off);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;

  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let dataOff = -1;
  let dataLen = 0;

  let off = 12;
  while (off + 8 <= buf.byteLength) {
    const id   = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        format:     view.getUint16(body, true),
        channels:   view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits:       view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      dataOff = body;
      dataLen = Math.min(size, buf.byteLength - body);
    }
    off = body + size + (size % 2);
  }
  if (!fmt || dataOff < 0 || fmt.channels < 1 || fmt.sampleRate <= 0) return null;

  const { format, channels: nCh, sampleRate, bits } = fmt;
  const bytesPerSample = bits / 8;
  const frameCount = Math.floor(dataLen / (bytesPerSample * nCh));
  if (frameCount === 0) return null;

  const read = makeSampleReader(view, bits, format);
  if (!read) return null;

  const channels = Array.from({ length: nCh }, () => new Float32Array(frameCount));
  for (let i = 0; i < frameCount; i++) {
    const frameOff = dataOff + i * bytesPerSample * nCh;
    for (let ch = 0; ch < nCh; ch++) {
      channels[ch][i] = read(frameOff + ch * bytesPerSample);
    }
  }
  return { channels, sampleRate, durationSec: frameCount / sampleRate };
}

export async function decodeAudioChannels(blob: Blob): Promise<DecodedChannels> {
  const buf = await blob.arrayBuffer();

  const wav = parseWav(buf);
  if (wav) return wav;

  const ctx = new AudioContext();
  try {
    const audio = await ctx.decodeAudioData(buf);
    const channels = Array.from({ length: audio.numberOfChannels }, (_, ch) => audio.getChannelData(ch));
    return { channels, sampleRate: audio.sampleRate, durationSec: audio.duration };
  } finally {
    void ctx.close();
  }
}
