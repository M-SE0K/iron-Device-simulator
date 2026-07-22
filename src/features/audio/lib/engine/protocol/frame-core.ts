import type { EngineParams, WsServerMessage } from "../../../types";
import {
  BYTES_PER_SAMPLE, frameBytes,
  type AnalysisSession, type EngineRuntimeConfig, type RealSensingPair,
} from "../core";
import { deinterleave } from "../utils";
import { createFrameMessage, encodeProcessedPcmMessage } from "./analysis";

export function selectSensing(data: ArrayBuffer, config: EngineRuntimeConfig): RealSensingPair {
  const wireBytes = frameBytes(config);
  const samplesPerCh = config.samplesPerCh;
  const sensingStreamBytes = samplesPerCh * BYTES_PER_SAMPLE;

  if (data.byteLength === wireBytes + sensingStreamBytes * 2) {
    return {
      v: new Int16Array(data, wireBytes, samplesPerCh),
      i: new Int16Array(data, wireBytes + sensingStreamBytes, samplesPerCh),
    };
  }

  const planar = deinterleave(new Uint8Array(data, 0, wireBytes), samplesPerCh);
  return {
    v: planar.subarray(0, samplesPerCh),
    i: planar.subarray(samplesPerCh, samplesPerCh * 2),
  };
}

export interface FrameOutput {
  frameJson: WsServerMessage;
  binary?: ArrayBuffer;
}

export function processAnalysisFrame(
  session: AnalysisSession,
  data: ArrayBuffer,
  engineParams: EngineParams,
  config: EngineRuntimeConfig,
  frameIndex: number,
): FrameOutput | null {
  const wireBytes = frameBytes(config);
  if (data.byteLength < wireBytes) return null;

  const input = new Int16Array(data.slice(0, wireBytes));
  const sensing = selectSensing(data, config);

  const result = session.analyze(new Uint8Array(data), engineParams, sensing);
  const frameJson = createFrameMessage(frameIndex, config.sampleRate, config.samplesPerCh, result);

  const binary = result.processedPcm
    ? encodeProcessedPcmMessage(frameIndex, input, result.processedPcm)
    : undefined;

  return { frameJson, binary };
}
