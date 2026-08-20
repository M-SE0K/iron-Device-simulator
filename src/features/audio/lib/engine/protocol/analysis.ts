import type { EngineFrameMessage, EngineMessage, EngineParams } from "../../../types";
import { SAMPLE_RATE, SAMPLES_PER_CH, DEFAULT_AMBIENT_TEMP } from "../core";
import type { FrameResult } from "../core";

export interface EngineInitPayload {
  sampleRate: number;
  bufferSize: number;
  ambientTemp: string;
}

export function parseEngineParams(payload: EngineInitPayload): EngineParams {
  const rawAmbientTemp = parseFloat(String(payload.ambientTemp ?? ""));
  return {
    ambientTemp: isFinite(rawAmbientTemp) ? rawAmbientTemp : DEFAULT_AMBIENT_TEMP,
  };
}

export function parseSampleRate(payload: EngineInitPayload): number {
  const rawRate = typeof payload.sampleRate === "number" ? payload.sampleRate : 0;
  return rawRate > 0 ? rawRate : SAMPLE_RATE;
}

export function parseSamplesPerCh(payload: EngineInitPayload): number {
  const raw = typeof payload.bufferSize === "number" ? payload.bufferSize : 0;
  return raw > 0 ? raw : SAMPLES_PER_CH;
}

function calculateFrameTime(frameIndex: number, sampleRate: number, samplesPerCh: number): number {
  return parseFloat(((frameIndex * samplesPerCh) / sampleRate).toFixed(6));
}

export function createFrameMessage(
  frameIndex: number,
  sampleRate: number,
  samplesPerCh: number,
  frame: FrameResult,
): EngineFrameMessage {
  const time = calculateFrameTime(frameIndex, sampleRate, samplesPerCh);
  return {
    type: "frame",
    frameIndex,
    time,
    temperature: frame.temperature,
    excursion: frame.excursion,
    processingMs: frame.processingMs,
    tempOverflow: frame.tempOverflow,
  };
}

export function createReadyMessage(warmupDroppedFrames = 0): EngineMessage {
  return { type: "ready", warmupDroppedFrames };
}

export function createErrorMessage(message: string): EngineMessage {
  return { type: "error", message };
}
