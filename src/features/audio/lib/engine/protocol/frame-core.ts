/**
 * engine/protocol/frame-core.ts — 분석 프레임 처리 코어 (전송 계층 독립)
 *
 * "PCM 프레임 1개 → frame JSON + 보호 PCM 바이너리"로 바꾸는 순수 로직만 모은다. 전송 방식만
 * 호출자가 다르게 감싼다:
 *   - protocol/local-socket.ts : in-process(메인 스레드) — queueMicrotask emit
 *   - worker/dsp-worker.ts     : Web Worker              — postMessage(transfer)
 *
 * V/I sensing 선택 규약(ff_prot의 v_sensing/i_sensing을 어디서 뽑는가)이 ABI 민감부라,
 * 이 파일 한 곳에만 두어 두 경로가 갈라지지 않게 한다. (규약 배경은 core.ts RealSensingPair 주석)
 */

import type { EngineParams, WsServerMessage } from "../../../types";
import {
  BYTES_PER_SAMPLE, frameBytes,
  type AnalysisSession, type EngineRuntimeConfig, type RealSensingPair,
} from "../core";
import { deinterleave } from "../utils";
import { createFrameMessage, encodeProcessedPcmMessage } from "./analysis";

/**
 * 프레임 버퍼에서 v_sensing/i_sensing 한 쌍을 고른다 — 어느 쪽이든 NULL은 넘기지 않는다
 * (NULL이면 ff_prot.c가 PCM RMS 근사로 조용히 대체해버려서, 실측 센싱이 있어도 근사로 도는 걸
 * 눈치채기 어렵다).
 *
 *  1) sensing 꼬리가 정확히 2×samplesPerCh int16만큼 붙어 있으면(4ch 이상 장치) 그걸 쓴다.
 *     애매하게 남는 바이트(잘못된 길이)는 이 분기에 안 걸려 아래 폴백으로 내려간다.
 *  2) 꼬리가 없으면 buf의 ch0(V)/ch1(I)를 쓴다 — reframeNativeChunk.ts의 채널 규약상
 *     ch0=V/ch1=I라, 분석 buf에 실리는 그 두 채널이 곧 센싱 데이터다.
 */
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

  // deinterleave는 새 배열을 돌려주므로 subarray 뷰를 그대로 넘겨도 호출자와 버퍼를 공유하지 않는다.
  const planar = deinterleave(new Uint8Array(data, 0, wireBytes), samplesPerCh);
  return {
    v: planar.subarray(0, samplesPerCh),
    i: planar.subarray(samplesPerCh, samplesPerCh * 2),
  };
}

/** 한 프레임 분석 결과 — frame JSON(항상) + 보호 PCM 바이너리(엔진이 내주면). */
export interface FrameOutput {
  /** "frame" 제어 메시지(JSON) — 같은 frameIndex의 바이너리와 짝 */
  frameJson: WsServerMessage;
  /** 보호 감쇠 PCM 바이너리(frameIndex 헤더 + input/protected 인터리브) — includeProcessedPcm일 때만 */
  binary?: ArrayBuffer;
}

/**
 * PCM 프레임 1개를 분석해 전송용 출력으로 만든다. 와이어 크기 미만이면 null(호출자가 프레임
 * 인덱스를 소비하지 않도록). analyze()가 throw하면 그대로 전파하니 호출자가 error 메시지로 감싼다.
 *
 * analyze는 planar를 WASM 힙에 복사해 실행하므로 `data`를 변형하지 않는다 → input을 분석 뒤에
 * 떠도 안전하지만, 프레임 경계가 보호 PCM과 정확히 같아야 하므로 같은 버퍼를 잘라 쓴다.
 */
export function processAnalysisFrame(
  session: AnalysisSession,
  data: ArrayBuffer,
  engineParams: EngineParams,
  config: EngineRuntimeConfig,
  frameIndex: number,
): FrameOutput | null {
  const wireBytes = frameBytes(config);
  if (data.byteLength < wireBytes) return null;

  // analyze()가 감쇠 결과를 만들기 전의 "감쇠 전" 원본 — 비교 뷰가 쓴다.
  const input = new Int16Array(data.slice(0, wireBytes));
  const sensing = selectSensing(data, config);

  const result = session.analyze(new Uint8Array(data), engineParams, sensing);
  const frameJson = createFrameMessage(frameIndex, config.sampleRate, config.samplesPerCh, result);

  // 보호 감쇠 PCM은 JSON에 못 실으므로 같은 frameIndex를 단 바이너리로 뒤따라 보낸다.
  const binary = result.processedPcm
    ? encodeProcessedPcmMessage(frameIndex, input, result.processedPcm)
    : undefined;

  return { frameJson, binary };
}
