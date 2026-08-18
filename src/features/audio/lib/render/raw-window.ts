import { INT16_SCALE } from "@/features/audio/lib/engine/core";
import type { CaptureSnapshot } from "@/features/audio/components/player/capture/types";
import type { SeriesReadBuffer } from "./read-buffer";

export function readRawWindow(
  snap: CaptureSnapshot,
  channel: number,
  minSec: number,
  maxSec: number,
  out: SeriesReadBuffer,
): number {
  const { channels, sampleRate, samplesPerFrame, pcm } = snap;
  if (!(sampleRate > 0) || samplesPerFrame <= 0) return 0;
  if (channel < 0 || channel >= channels) return 0;

  const frameCount = Math.floor(snap.totalFrames / samplesPerFrame);
  if (frameCount === 0) return 0;

  const capacity = Math.min(out.xs.length, out.ys.length);
  if (capacity === 0) return 0;

  const totalSamples = frameCount * samplesPerFrame;
  let start = Number.isFinite(minSec) ? Math.floor(minSec * sampleRate) : 0;
  let end = Number.isFinite(maxSec) ? Math.ceil(maxSec * sampleRate) + 1 : totalSamples;
  if (start < 0) start = 0;
  if (end > totalSamples) end = totalSamples;
  if (end <= start) return 0;
  if (end - start > capacity) end = start + capacity;

  const step = 1 / sampleRate;
  let frameIdx = Math.floor(start / samplesPerFrame);
  let offset = start - frameIdx * samplesPerFrame;
  let view = pcm.frame(frameIdx);

  let w = 0;
  for (let s = start; s < end; s++) {
    if (offset >= samplesPerFrame) {
      frameIdx++;
      if (frameIdx >= frameCount) break;
      offset = 0;
      view = pcm.frame(frameIdx);
    }
    out.xs[w] = s * step;
    out.ys[w] = view[offset * channels + channel] / INT16_SCALE;
    w++;
    offset++;
  }
  return w;
}
