import { CHANNELS, BYTES_PER_SAMPLE, INT16_MAX, INT16_MIN } from "./core";

/* 와이어 int16 로 내리는 유일한 산식 — 디코드 결과는 [-1,1] 로 클램프돼 있지 않아서
 * (손실 코덱의 인터샘플 오버슈트, 리샘플링 오버슈트) 여기서 잘린다. 파형 비교가 엔진이
 * 실제로 받는 값과 같은 스케일을 보려면 이 함수를 거친 값을 봐야 한다. */
export function toInt16(x: number): number {
  return Math.max(INT16_MIN, Math.min(INT16_MAX, Math.round(x * INT16_MAX)));
}

export function encodeToInt16(ch0: Float32Array, ch1: Float32Array): Int16Array {
  const out = new Int16Array(ch0.length * 2);
  for (let i = 0; i < ch0.length; i++) {
    out[i * 2]     = toInt16(ch0[i]);
    out[i * 2 + 1] = toInt16(ch1[i]);
  }
  return out;
}

/** 인터리브 Float32 의 [frameOffset, frameOffset+frames) 구간을 `encodeToInt16` 과 똑같이
 *  양자화해 `out` 에 채운다. 반환값은 클램프가 일어난 채널의 비트마스크(bit c = 채널 c). */
export function quantizeInterleaved(
  src: Float32Array,
  frameOffset: number,
  frames: number,
  out: Int16Array,
): number {
  const n = frames * CHANNELS;
  const base = frameOffset * CHANNELS;
  let clippedMask = 0;
  for (let i = 0; i < n; i++) {
    const raw = Math.round(src[base + i] * INT16_MAX);
    const v = raw > INT16_MAX ? INT16_MAX : raw < INT16_MIN ? INT16_MIN : raw;
    if (v !== raw) clippedMask |= 1 << (i % CHANNELS);
    out[i] = v;
  }
  return clippedMask;
}

/** 인터리브 N채널 프레임의 특정 채널만 제자리에서 0 으로 덮는다. */
export function zeroChannel(frame: Int16Array, channels: number, channel: number): void {
  if (channel < 0 || channel >= channels) return;
  for (let i = channel; i < frame.length; i += channels) frame[i] = 0;
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
