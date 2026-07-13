// 워크스페이스에 저장된 오디오 Blob을 채널별(평면) Float32 파형으로 디코딩한다.
//   · wav-encoder.ts가 만든 N채널 int32 PCM WAV(마이크 전 채널 캡처, ch0=V/ch1=I)를
//     그대로 되읽는 것이 1차 목적 — 브라우저 decodeAudioData는 32bit int PCM이나
//     다채널 WAV 지원이 보장되지 않아 RIFF 청크를 직접 파싱한다(int16/int32/float32).
//   · WAV가 아니거나 파싱에 실패하면(원본 mp3 업로드 저장 등) decodeAudioData로 폴백.

import { readTag, makeSampleReader } from "./wav-primitives";

export interface DecodedChannels {
  /** 채널별 평면 파형, [-1, 1] 정규화 — 인덱스가 곧 채널 번호(ch0=V, ch1=I, ch2..=확장) */
  channels: Float32Array[];
  sampleRate: number;
  durationSec: number;
}

/** RIFF/WAVE 청크를 걸어 fmt·data를 찾아 평면 Float32로 변환. WAV가 아니면 null. */
function parseWav(buf: ArrayBuffer): DecodedChannels | null {
  const view = new DataView(buf);
  if (buf.byteLength < 44) return null;
  const tag = (off: number) => readTag(view, off);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;

  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let dataOff = -1;
  let dataLen = 0;

  // 12바이트 RIFF 헤더 이후 청크 순회 (fmt /data 외 청크는 건너뜀, 홀수 길이 패딩 처리)
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

  // 지원 포맷: PCM(1) int16/int32, IEEE float(3) float32 — 그 외는 폴백에 맡긴다.
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

/** Blob → 채널별 파형. WAV 직접 파싱 우선, 실패 시 decodeAudioData 폴백. */
export async function decodeAudioChannels(blob: Blob): Promise<DecodedChannels> {
  const buf = await blob.arrayBuffer();

  const wav = parseWav(buf);
  if (wav) return wav;

  // WAV가 아닌 포맷(원본 mp3 저장 등) — 브라우저 디코더 사용. AudioContext 리샘플링이
  // 있을 수 있으나 채널 수는 보존되며, 표시용이므로 문제없다.
  const ctx = new AudioContext();
  try {
    const audio = await ctx.decodeAudioData(buf);
    const channels = Array.from({ length: audio.numberOfChannels }, (_, ch) => audio.getChannelData(ch));
    return { channels, sampleRate: audio.sampleRate, durationSec: audio.duration };
  } finally {
    void ctx.close();
  }
}
