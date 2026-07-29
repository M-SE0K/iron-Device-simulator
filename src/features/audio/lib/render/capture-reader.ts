import { INT16_SCALE } from "@/features/audio/lib/engine/core";
import type { CaptureSnapshot } from "@/features/audio/components/player/capture/types";

/**
 * CaptureSnapshot에서 한 채널의 [startFrame, endFrame) 구간을 -1..1 Float32로 뽑는다.
 * decodeWavRange(wav-incremental.ts)의 대체품 — WAV Blob 슬라이스/파싱 없이 인터리브
 * int16 프레임 배열을 직접 인덱싱하므로 비용이 요청 구간 길이에만 비례한다(세션 길이 무관).
 */
export function readChannelSegment(
  snap: CaptureSnapshot,
  channel: number,
  startFrame: number,
  endFrame: number,
): Float32Array {
  const { channels, samplesPerFrame, frames } = snap;
  if (!(samplesPerFrame > 0) || channel < 0 || channel >= channels) return new Float32Array(0);

  const total = frames.length * samplesPerFrame;
  const clampedEnd = Math.max(0, Math.min(endFrame, total));
  const clampedStart = Math.max(0, Math.min(startFrame, clampedEnd));
  const out = new Float32Array(clampedEnd - clampedStart);
  if (out.length === 0) return out;

  let written = 0;
  let frameIdx = Math.floor(clampedStart / samplesPerFrame);
  let offsetInFrame = clampedStart - frameIdx * samplesPerFrame;

  while (written < out.length && frameIdx < frames.length) {
    const view = new Int16Array(frames[frameIdx]); // 뷰 생성일 뿐, 복사 아님
    const n = Math.min(samplesPerFrame - offsetInFrame, out.length - written);
    for (let i = 0; i < n; i++) {
      out[written + i] = view[(offsetInFrame + i) * channels + channel] / INT16_SCALE;
    }
    written += n;
    offsetInFrame = 0;
    frameIdx++;
  }

  return written === out.length ? out : out.subarray(0, written);
}
