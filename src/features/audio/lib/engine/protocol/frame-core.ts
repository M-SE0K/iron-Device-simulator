import type { EngineParams, WsServerMessage } from "../../../types";
import {
  frameBytes,
  type AnalysisSession, type EngineRuntimeConfig, type RealSensingPair,
} from "../core";
import { deinterleave } from "../utils";
import { createFrameMessage, encodeProcessedPcmMessage } from "./analysis";

// ch0=V/ch1=I는 MCHStreamer가 실측 V/I 센스 라인을 그대로 실어 보내는 채널(캡처 채널 수와
// 무관하게 항상 여기)이라 디인터리브하면 곧 실측 센싱 페어가 된다. 호출부(useNativeCapture.ts)가
// 넘기는 소스는 buf(재생 음원/무음)와는 별개 — 캡처된 wire 프레임 그대로다.
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

  // useNativeCapture.ts는 buf 프레임 + sensing 프레임을 이어붙인 2배 길이 메시지를 보낸다
  // (buf = 재생 음원/무음, sensing = 캡처된 V/I). 단일 길이 메시지(웹 getUserMedia 폴백)는
  // 하위 호환으로 같은 소스를 buf/sensing 양쪽에 그대로 쓴다.
  const hasAudioOverride = data.byteLength >= wireBytes * 2;
  const bufBytes = data.slice(0, wireBytes);
  const sensingBytes = hasAudioOverride ? data.slice(wireBytes, wireBytes * 2) : bufBytes;

  const input = new Int16Array(bufBytes);
  const sensing = selectSensing(sensingBytes, config);

  const result = session.analyze(new Uint8Array(bufBytes), engineParams, sensing);
  const frameJson = createFrameMessage(frameIndex, config.sampleRate, config.samplesPerCh, result);

  const binary = result.processedPcm
    ? encodeProcessedPcmMessage(frameIndex, input, result.processedPcm)
    : undefined;

  return { frameJson, binary };
}
