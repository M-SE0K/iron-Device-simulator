import type { AnalysisFrame } from "@/features/audio/types";
import { findFrameIndex } from "@/shared/lib/utils";

export type ChannelMode = "L" | "R" | "Both";

export const WINDOW_SIZE = 1000;

export interface StreamWindowResult {
  current: [number, number] | null;
  windowFrames: AnalysisFrame[];
}

export function computeStreamWindow(
  frames: AnalysisFrame[],
  currentTime: number,
  isActive: boolean,
  streaming: boolean,
  audioDuration: number | null | undefined,
  windowSize: number,
  pick: (f: AnalysisFrame) => [number, number],
): StreamWindowResult {
  if (!isActive || frames.length === 0) {
    return { current: null, windowFrames: frames.slice(0, windowSize) };
  }

  if (streaming) {
    const lastFrame = frames[frames.length - 1];
    return { current: lastFrame ? pick(lastFrame) : null, windowFrames: frames };
  }

  const frameIdx = findFrameIndex(frames.map((f) => f.time), currentTime);
  const current   = frameIdx >= 0 && frames[frameIdx] ? pick(frames[frameIdx]) : null;
  const start     = Math.max(0, frameIdx - (windowSize - 1));
  return { current, windowFrames: frames.slice(start, frameIdx + 1) };
}

export function computeExcursionYRange(
  windowFrames: AnalysisFrame[],
  channelMode: ChannelMode,
  toDisplayUnit: (v: number) => number,
  scalePadding: number,
): { yMin: number; yMax: number } {
  if (windowFrames.length === 0) return { yMin: -0.01, yMax: 0.01 };

  let rawMin = Infinity;
  let rawMax = -Infinity;
  const consider = (v: number) => { if (v < rawMin) rawMin = v; if (v > rawMax) rawMax = v; };
  for (const f of windowFrames) {
    if (channelMode !== "R") {
      consider(f.excursion[0]);
      if (f.excursionMin) consider(f.excursionMin[0]);
      if (f.excursionMax) consider(f.excursionMax[0]);
    }
    if (channelMode !== "L") {
      consider(f.excursion[1]);
      if (f.excursionMin) consider(f.excursionMin[1]);
      if (f.excursionMax) consider(f.excursionMax[1]);
    }
  }
  if (!isFinite(rawMin) || !isFinite(rawMax)) return { yMin: -0.01, yMax: 0.01 };

  const dataMin = toDisplayUnit(rawMin);
  const dataMax = toDisplayUnit(rawMax);
  const span    = Math.max(dataMax - dataMin, 0.001);
  const pad     = span * (scalePadding - 1);
  return { yMin: dataMin - pad, yMax: dataMax + pad };
}

export function computeTemperatureYRange(
  windowFrames: AnalysisFrame[],
  channelMode: ChannelMode,
): { yMin: number; yMax: number } {
  let dataMax = -Infinity;
  let dataMin = Infinity;
  for (const f of windowFrames) {
    if (channelMode !== "R") { const v = f.temperature[0]; if (v > dataMax) dataMax = v; if (v < dataMin) dataMin = v; }
    if (channelMode !== "L") { const v = f.temperature[1]; if (v > dataMax) dataMax = v; if (v < dataMin) dataMin = v; }
  }

  const niceStep = (v: number) => (v <= 200 ? 10 : v <= 500 ? 25 : v <= 1000 ? 50 : 100);

  let yMax = 100;
  if (isFinite(dataMax) && dataMax > 100) {
    const withHeadroom = dataMax * 1.08;
    const step = niceStep(withHeadroom);
    yMax = Math.ceil(withHeadroom / step) * step;
  }

  let yMin = 0;
  if (isFinite(dataMin) && dataMin < 0) {
    const withHeadroom = dataMin * 1.08;
    const step = niceStep(Math.abs(withHeadroom));
    yMin = Math.floor(withHeadroom / step) * step;
  }

  return { yMin, yMax };
}
