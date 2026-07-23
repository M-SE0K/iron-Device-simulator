import type { EngineParams, WsServerMessage } from "../../../types";
import {
  frameBytes,
  type AnalysisSession, type EngineRuntimeConfig, type RealSensingPair,
} from "../core";
import { deinterleave } from "../utils";
import { createFrameMessage, encodeProcessedPcmMessage } from "./analysis";

// ch0=V/ch1=I는 MCHStreamer가 실측 V/I 센스 라인을 그대로 실어 보내는 채널이라(캡처
// 채널 수와 무관하게 항상 여기) buf 자체를 디인터리브하면 곧 실측 센싱 페어가 된다.
function selectSensing(data: ArrayBuffer, config: EngineRuntimeConfig): RealSensingPair {
  const wireBytes = frameBytes(config);
  const samplesPerCh = config.samplesPerCh;
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
