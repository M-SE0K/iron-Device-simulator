/**
 * engine/protocol/analysis.ts — 분석 프로토콜 공통 헬퍼
 * protocol/local-socket.ts(로컬 WASM)가 사용하는 프로토콜 파싱·메시지 생성 로직을 모아둔다. (init, frame, pause, stop 메시지 처리)
 */

import type { EngineParams, WsServerMessage } from "../../../types";
import { SAMPLE_RATE, SAMPLES_PER_CH, DEFAULT_AMBIENT_TEMP, CHANNELS, BYTES_PER_SAMPLE } from "../core";
import type { FrameResult } from "../core";


// ─── 메시지 파싱 ────────────────────────────────────────────────────────────
// JSON 제어 메시지에서 엔진 파라미터 추출 (init 메시지) - 미설정/잘못된 값은 기본값으로 대체한다.
export function parseEngineParams(msg: Record<string, unknown>): EngineParams {
  const rawPower = parseFloat(String(msg.ampOutputPower ?? ""));
  const rawAmbientTemp = parseFloat(String(msg.ambientTemp ?? ""));
  return {
    ampOutputPower: isFinite(rawPower) && rawPower > 0 ? rawPower : null,
    speakerModel: typeof msg.speakerModel === "string" ? msg.speakerModel : "",
    ambientTemp: isFinite(rawAmbientTemp) ? rawAmbientTemp : DEFAULT_AMBIENT_TEMP,
  };
}

// JSON 제어 메시지에서 샘플레이트 추출 (init 메시지) - 파일/마이크 두 모드 모두 Calibration 값을 실어 보낸다 — 미설정/잘못된 값만 기본값 48000.
export function parseSampleRate(msg: Record<string, unknown>): number {
  const rawRate = typeof msg.sampleRate === "number" ? msg.sampleRate : 0;
  return rawRate > 0 ? rawRate : SAMPLE_RATE;
}

// JSON 제어 메시지에서 버퍼 사이즈(채널당 샘플 수) 추출 (init 메시지) - 미설정/잘못된 값은 기본값 480으로 대체한다.
export function parseSamplesPerCh(msg: Record<string, unknown>): number {
  const raw = typeof msg.bufferSize === "number" ? msg.bufferSize : 0;
  return raw > 0 ? raw : SAMPLES_PER_CH;
}


// ─── 메시지 생성 ────────────────────────────────────────────────────────────
// 프레임 인덱스를 오디오 시간(초)으로 변환한다. 시간 = (프레임 인덱스 × samplesPerCh) / sampleRate
// 소수 6자리(μs 단위)로 반올림 — BUFFER_SIZE_OPTIONS/SAMPLE_RATE_OPTIONS의 최소 프레임 간격
// (8 samples / 384000 Hz ≈ 20.8μs)보다 촘촘해야 연속 프레임의 시간이 같은 값으로 뭉개지지 않는다.
// (과거 toFixed(4)=0.1ms 단위는 이 극단 설정에서 여러 프레임이 동일 타임스탬프로 겹치는 문제가 있었다.)
function calculateFrameTime(frameIndex: number, sampleRate: number, samplesPerCh: number): number {
  return parseFloat(((frameIndex * samplesPerCh) / sampleRate).toFixed(6));
}

//분석 프레임을 WebSocket 메시지로 변환한다. - 시간 정보를 추가하고, 구조화된 응답 객체를 반환한다.
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

// ─── 보호 PCM 바이너리 메시지 ────────────────────────────────────────────────
// 감쇠가 적용된 PCM은 JSON에 실을 수 없어(문자열화 비용·크기) 별도 바이너리 메시지로 나간다.
// 실제 WebSocket도 텍스트/바이너리를 섞어 보낼 수 있으므로 SocketLike 추상화는 유지된다.
//
//   [0..3]              int32 LE  frameIndex — 같은 인덱스의 "frame" JSON 메시지와 짝
//   [4..7]              int32 LE  samplesPerCh — input/protected 경계
//   [8 .. 8+N)          int16 LE  input     PCM (2ch 인터리브, 감쇠 전)
//   [8+N .. 8+2N)       int16 LE  protected PCM (2ch 인터리브, 감쇠 후)   N = samplesPerCh*2*2 bytes
//
// 입력을 같이 싣는 이유: 비교 뷰가 "같은 샘플 구간"의 전후를 나란히 놓으려면 원본이 분석
// 프레임과 정확히 같은 경계여야 한다. 캡처 청크(rawCaptureRef)는 프레임 경계도 채널 수도
// 달라서 인덱스로 짝지을 수 없다 — 어긋난 비교는 보여줄 가치가 없으므로 여기서 짝을 확정한다.
// 인덱스를 헤더에 넣는 이유도 같다: 도착 순서에만 기대면 유실·재정렬을 감지할 수 없다.
export const PROCESSED_PCM_HEADER_BYTES = 8;

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

  // 길이가 헤더의 samplesPerCh와 안 맞으면 잘린/깨진 메시지다 — 조용히 어긋난 PCM을
  // 붙이느니 버린다.
  if (samplesPerCh <= 0 || data.byteLength !== PROCESSED_PCM_HEADER_BYTES + halfBytes * 2) return null;

  return {
    frameIndex,
    input:     new Int16Array(data, PROCESSED_PCM_HEADER_BYTES, samplesPerCh * CHANNELS),
    processed: new Int16Array(data, PROCESSED_PCM_HEADER_BYTES + halfBytes, samplesPerCh * CHANNELS),
  };
}

// 초기화 완료 응답 메시지 생성
export function createReadyMessage(): WsServerMessage {
  return { type: "ready" };
}

//에러 응답 메시지 생성
export function createErrorMessage(message: string): WsServerMessage {
  return { type: "error", message };
}
