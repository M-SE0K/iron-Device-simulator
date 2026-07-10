// ChartDetailOverlay 채널 뷰가 과거 구간을 다룰 때 쓰는 온디맨드 WAV 디코딩.
//   · wav-decoder.ts(parseWav)는 "정적인 완성된 파일"을 한 번에 전부 디코딩하는 범용
//     RIFF 파서다 — 임의의 WAV/포맷을 받아들여야 해서 청크를 처음부터 순회한다.
//   · 반면 여기서 다루는 Blob은 항상 wav-encoder.ts의 pcmFramesToWavBlob()이 만든
//     것 하나뿐이다(고정 44바이트 헤더, PCM, 단일 data 청크) — 이 전제 위에서 헤더는
//     44바이트만 살짝 엿보고(peek), "요청받은 시간 구간만" 잘라 디코딩한다.
//   · 라이브(현재) 구간은 이걸 쓰지 않는다 — 캡처 청크가 들어올 때마다 즉시 push되므로
//     (ChartDetailOverlay의 handleChunk), 여기서는 채널을 새로 선택했을 때의 1회 백필과
//     dataZoom으로 과거를 확대했을 때의 온디맨드 조회만 담당한다.

export interface WavHeader {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** 항상 44 — pcmFramesToWavBlob 고정 헤더 */
  dataOffset: number;
  dataSize: number;
  durationSec: number;
}

const HEADER_BYTES = 44;

function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3),
  );
}

/** 44바이트만 읽어 채널 수/샘플레이트/전체 길이를 얻는다 — 전체 샘플을 훑지 않아 사실상 무료. */
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

function makeSampleReader(view: DataView, bitsPerSample: number): (byteOffset: number) => number {
  if (bitsPerSample === 32) return (o) => view.getInt32(o, true) / 0x80000000;
  if (bitsPerSample === 16) return (o) => view.getInt16(o, true) / 0x8000;
  throw new Error(`지원하지 않는 bitsPerSample: ${bitsPerSample}`);
}

/**
 * [startSec, endSec) 구간을 온디맨드로 슬라이스 디코딩한다 — 과거 구간을 확대해서 볼 때
 * (dataZoom이 실시간 윈도우 밖으로 나갔을 때) 그 구간에 해당하는 바이트만 잘라 읽으므로
 * 비용이 요청한 구간 길이에만 비례한다(전체 세션 길이와 무관).
 */
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

  const frameCount = Math.floor(buf.byteLength / blockAlign);
  const out = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) out[i] = read(i * blockAlign + channel * bytesPerSample);
  return out;
}

/** 기존 윈도우 뒤에 새 샘플을 이어붙이고, 총 길이가 maxSamples를 넘으면 앞을 잘라 상한을 지킨다. */
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
