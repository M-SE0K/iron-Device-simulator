import { INT16_SCALE } from "@/features/audio/lib/engine/core";

/**
 * 인터리브 int16 PCM에서 채널 하나를 뽑아 [-1, 1) float으로 `out`에 채운다 — `out.length`
 * 프레임만큼 읽는다. 라이브 청크·백필·보호 감쇠 프레임이 전부 같은 모양의 루프를 각자
 * 갖고 있던 것을 이 한 곳으로 모았다.
 *
 * 호출부는 `out`을 재사용해도 된다 — ChannelWaveStore.addBlock()은 값을 즉시 버킷으로
 * 소화하고 배열 참조를 보관하지 않는다(스토어 쪽 규약 참고).
 */
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

/**
 * 인터리브 float PCM에서 채널 하나의 [startFrame, startFrame+out.length) 구간을 out에 채우고
 * **실제로 채운 프레임 수**를 돌려준다 — 마지막 조각은 짧을 수 있다. int16 판과 달리 스케일
 * 변환이 없다. 긴 파일을 전체 길이의 채널 배열 없이 고정 scratch로 잘라 소화하는 용도다.
 */
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
