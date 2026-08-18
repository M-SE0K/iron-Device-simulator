import type { EngineFrameMessage, EngineParams } from "../../../types";
import {
  frameBytes,
  type AnalysisSession, type EngineRuntimeConfig, type RealSensingPair,
} from "../core";
import { deinterleave } from "../utils";
import { createFrameMessage } from "./analysis";

function selectSensing(data: ArrayBuffer, config: EngineRuntimeConfig): RealSensingPair {
  const wireBytes = frameBytes(config);
  const samplesPerCh = config.samplesPerCh;
  const planar = deinterleave(new Uint8Array(data, 0, wireBytes), samplesPerCh);
  return {
    v: planar.subarray(0, samplesPerCh),
    i: planar.subarray(samplesPerCh, samplesPerCh * 2),
  };
}

export interface ProtectedPcm {
  frameIndex: number;
  input: Int16Array;
  processed: Int16Array;
}

export interface FrameOutput {
  frame: EngineFrameMessage;
  pcm: ProtectedPcm;
}

export function processAnalysisFrame(
  session: AnalysisSession,
  data: ArrayBuffer,
  engineParams: EngineParams,
  config: EngineRuntimeConfig,
  frameIndex: number,
): FrameOutput | null {
  const wireBytes = frameBytes(config);
  if (data.byteLength < wireBytes * 2) return null;

  const bufBytes = data.slice(0, wireBytes);
  const sensingBytes = data.slice(wireBytes, wireBytes * 2);

  const input = new Int16Array(bufBytes);
  const sensing = selectSensing(sensingBytes, config);

  const result = session.analyze(new Uint8Array(bufBytes), engineParams, sensing);
  const frame = createFrameMessage(frameIndex, config.sampleRate, config.samplesPerCh, result);

  return { frame, pcm: { frameIndex, input, processed: result.processedPcm } };
}
