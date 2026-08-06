import type { EngineParams, WsServerMessage } from "../../../types";
import { SAMPLE_RATE, SAMPLES_PER_CH, DEFAULT_AMBIENT_TEMP, CHANNELS, BYTES_PER_SAMPLE } from "../core";
import type { FrameResult } from "../core";


export function parseEngineParams(msg: Record<string, unknown>): EngineParams {
  const rawPower = parseFloat(String(msg.ampOutputPower ?? ""));
  const rawAmbientTemp = parseFloat(String(msg.ambientTemp ?? ""));
  return {
    ampOutputPower: isFinite(rawPower) && rawPower > 0 ? rawPower : null,
    speakerModel: typeof msg.speakerModel === "string" ? msg.speakerModel : "",
    ambientTemp: isFinite(rawAmbientTemp) ? rawAmbientTemp : DEFAULT_AMBIENT_TEMP,
  };
}

export function parseSampleRate(msg: Record<string, unknown>): number {
  const rawRate = typeof msg.sampleRate === "number" ? msg.sampleRate : 0;
  return rawRate > 0 ? rawRate : SAMPLE_RATE;
}

export function parseSamplesPerCh(msg: Record<string, unknown>): number {
  const raw = typeof msg.bufferSize === "number" ? msg.bufferSize : 0;
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
): WsServerMessage {
  const time = calculateFrameTime(frameIndex, sampleRate, samplesPerCh);
  return {
    type: "frame",
    frameIndex,
    time,
    temperature: frame.temperature,
    excursion: frame.excursion,
    processingMs: frame.processingMs,
  };
}

const PROCESSED_PCM_HEADER_BYTES = 8;

export function encodeProcessedPcmMessage(
  frameIndex: number,
  input: Int16Array,
  processed: Int16Array,
): ArrayBuffer {
  const out  = new ArrayBuffer(PROCESSED_PCM_HEADER_BYTES + input.byteLength + processed.byteLength);
  const view = new DataView(out);
  view.setInt32(0, frameIndex, true);
  view.setInt32(4, input.length / CHANNELS, true);
  new Int16Array(out, PROCESSED_PCM_HEADER_BYTES, input.length).set(input);
  new Int16Array(out, PROCESSED_PCM_HEADER_BYTES + input.byteLength, processed.length).set(processed);
  return out;
}

export function decodeProcessedPcmMessage(
  data: ArrayBuffer,
): { frameIndex: number; input: Int16Array; processed: Int16Array } | null {
  if (data.byteLength <= PROCESSED_PCM_HEADER_BYTES) return null;

  const view         = new DataView(data);
  const frameIndex   = view.getInt32(0, true);
  const samplesPerCh = view.getInt32(4, true);
  const halfBytes    = samplesPerCh * CHANNELS * BYTES_PER_SAMPLE;

  if (samplesPerCh <= 0 || data.byteLength !== PROCESSED_PCM_HEADER_BYTES + halfBytes * 2) return null;

  return {
    frameIndex,
    input:     new Int16Array(data, PROCESSED_PCM_HEADER_BYTES, samplesPerCh * CHANNELS),
    processed: new Int16Array(data, PROCESSED_PCM_HEADER_BYTES + halfBytes, samplesPerCh * CHANNELS),
  };
}

export function createReadyMessage(warmupDroppedFrames = 0): WsServerMessage {
  return { type: "ready", warmupDroppedFrames };
}

export function createErrorMessage(message: string): WsServerMessage {
  return { type: "error", message };
}
