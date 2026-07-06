/**
 * engine/protocol/analysis.ts — 분석 프로토콜 공통 헬퍼
 *
 * protocol/local-socket.ts(로컬 WASM)가 사용하는 프로토콜 파싱·메시지 생성
 * 로직을 모아둔다. (init, frame, pause, stop 메시지 처리)
 */

import type { EngineParams, WsServerMessage } from "../../../types";
import { SAMPLE_RATE, SAMPLES_PER_CH } from "../core";
import type { FrameResult } from "../core";

// ─── 메시지 파싱 ────────────────────────────────────────────────────────────

/**
 * JSON 제어 메시지에서 엔진 파라미터 추출 (init 메시지)
 * 미설정/잘못된 값은 기본값으로 대체한다.
 */
export function parseEngineParams(msg: Record<string, unknown>): EngineParams {
  const rawPower = parseFloat(String(msg.ampOutputPower ?? ""));
  return {
    ampOutputPower: isFinite(rawPower) && rawPower > 0 ? rawPower : null,
    speakerModel: typeof msg.speakerModel === "string" ? msg.speakerModel : "",
  };
}

/**
 * JSON 제어 메시지에서 샘플레이트 추출 (init 메시지)
 * 마이크 모드에서 실제 값 전달, 파일 모드에서는 생략 → 기본값 48000
 */
export function parseSampleRate(msg: Record<string, unknown>): number {
  const rawRate = typeof msg.sampleRate === "number" ? msg.sampleRate : 0;
  return rawRate > 0 ? rawRate : SAMPLE_RATE;
}

// ─── 메시지 생성 ────────────────────────────────────────────────────────────

/**
 * 프레임 인덱스를 오디오 시간(초)으로 변환한다.
 *   프레임당 샘플 수: SAMPLES_PER_CH (480)
 *   샘플레이트: connSampleRate (기본 48000)
 *   시간 = (프레임 인덱스 × SAMPLES_PER_CH) / 샘플레이트
 */
function calculateFrameTime(frameIndex: number, sampleRate: number): number {
  return parseFloat(((frameIndex * SAMPLES_PER_CH) / sampleRate).toFixed(4));
}

/**
 * 분석 프레임을 WebSocket 메시지로 변환한다.
 * 시간 정보를 추가하고, 구조화된 응답 객체를 반환한다.
 */
export function createFrameMessage(
  frameIndex: number,
  sampleRate: number,
  frame: FrameResult,
): WsServerMessage {
  const time = calculateFrameTime(frameIndex, sampleRate);
  return {
    type: "frame",
    time,
    temperature: frame.temperature,
    excursion: frame.excursion,
    processingMs: frame.processingMs,
  };
}

/**
 * 초기화 완료 응답 메시지 생성
 */
export function createReadyMessage(): WsServerMessage {
  return { type: "ready" };
}

/**
 * 에러 응답 메시지 생성
 */
export function createErrorMessage(message: string): WsServerMessage {
  return { type: "error", message };
}
