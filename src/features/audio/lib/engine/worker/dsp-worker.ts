/**
 * engine/worker/dsp-worker.ts — WASM 분석 엔진을 구동하는 Web Worker(classic).
 *
 * LocalWasmSocket이 메인 스레드에서 동기로 하던 일(WASM ff_prot 실행 + deinterleave/interleave +
 * 보호 PCM 인코딩)을 통째로 워커로 옮긴 것. 메인 스레드는 protocol/worker-socket.ts(Phase 2)를
 * 통해 init/frame/stop만 주고받고 결과만 받는다 — 100fps 상시 부하가 렌더 스레드에서 빠진다.
 *
 * 프레임 처리는 protocol/frame-core.ts를 공유하므로 in-process 경로(LocalWasmSocket)와 갈라지지
 * 않는다. WASM glue(ff_prot.js)는 classic worker의 importScripts로 로드된다
 * (adapters/wasm-client.ts loadFactory 분기 + Phase 0 스파이크로 DOM-free 검증 완료).
 *
 * 프로토콜(메인 → 워커):   ← LocalWasmSocket.send()와 동일한 구분(문자열=제어, 바이너리=PCM)
 *   string(JSON)  { type: 'init' | 'stop', ... }   제어 메시지
 *   ArrayBuffer   PCM 프레임(transfer)              와이어 프레임(+선택적 V/I sensing 꼬리)
 * 프로토콜(워커 → 메인):   ← 실제 WebSocket 수신 모양 그대로(worker-socket이 투명 중계)
 *   string(JSON)  ready / frame / error
 *   ArrayBuffer   보호 PCM 바이너리(transfer)
 */

import { openClientWasmSession } from "../adapters/wasm-client";
import {
  DEFAULT_ENGINE_CONFIG, DEFAULT_AMBIENT_TEMP, frameBytes,
  type AnalysisSession, type EngineRuntimeConfig,
} from "../core";
import type { EngineParams } from "../../../types";
import {
  parseEngineParams, parseSampleRate, parseSamplesPerCh,
  createReadyMessage, createErrorMessage,
} from "../protocol/analysis";
import { processAnalysisFrame } from "../protocol/frame-core";

// self를 DOM lib(Window) 대신 워커에 필요한 부분만으로 좁게 타이핑한다 — tsconfig가 webworker
// lib을 안 켜서(DedicatedWorkerGlobalScope 미정의) 전역 self가 Window로 잡히는 걸 우회.
const ctx = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

// ── 세션 상태 (LocalWasmSocket의 인스턴스 필드와 1:1) ────────────────────────
let session: AnalysisSession | null = null;
let engineParams: EngineParams = { ampOutputPower: null, speakerModel: "", ambientTemp: DEFAULT_AMBIENT_TEMP };
let config: EngineRuntimeConfig = DEFAULT_ENGINE_CONFIG;
let frameCount = 0;
let initialized = false;

/** JSON 제어/결과 메시지는 문자열로 보낸다 — 소비자(useCaptureSession)가 문자열 e.data를 JSON.parse. */
function postJson(msg: unknown): void {
  ctx.postMessage(JSON.stringify(msg));
}
/** 보호 PCM은 ArrayBuffer로 보낸다 — transfer로 넘겨 메인 스레드 복사를 없앤다. */
function postBinary(buf: ArrayBuffer): void {
  ctx.postMessage(buf, [buf]);
}

// ── JSON 제어 메시지 (init/stop) — LocalWasmSocket.handleControl 이식 ──────────
async function handleControl(msg: { type: string } & Record<string, unknown>): Promise<void> {
  if (msg.type === "init") {
    if (initialized) {
      postJson(createReadyMessage());
      return;
    }

    engineParams = parseEngineParams(msg);
    config = {
      sampleRate: parseSampleRate(msg),
      samplesPerCh: parseSamplesPerCh(msg),
    };

    try {
      // includeProcessedPcm: 보호 감쇠 PCM을 프레임마다 바이너리로 흘려보낸다(비교 뷰 + WAV).
      session = await openClientWasmSession(config, { includeProcessedPcm: true });
    } catch (err) {
      postJson(createErrorMessage(String(err)));
      return;
    }

    initialized = true;
    frameCount = 0;
    postJson(createReadyMessage());

  } else if (msg.type === "stop") {
    session?.close();
    session = null;
    initialized = false;
  }
  // pause: 서버와 동일하게 별도 처리 없음(스트림은 클라이언트가 멈춤)
}

// ── Binary: PCM 프레임 — LocalWasmSocket.handleFrame 이식 ─────────────────────
function handleFrame(data: ArrayBuffer): void {
  if (!initialized || !session) return;
  // 와이어 크기 미만이면 프레임 인덱스를 소비하지 않고 버린다(짧은/깨진 프레임).
  if (data.byteLength < frameBytes(config)) return;

  const currentFrame = frameCount++;
  try {
    const out = processAnalysisFrame(session, data, engineParams, config, currentFrame);
    if (!out) return;
    postJson(out.frameJson);
    if (out.binary) postBinary(out.binary);
  } catch (err) {
    postJson(createErrorMessage(`ff_prot_start_exec 오류: ${err}`));
  }
}

ctx.onmessage = (e: MessageEvent) => {
  const data = e.data;
  if (typeof data === "string") {
    void handleControl(JSON.parse(data));
  } else if (data instanceof ArrayBuffer) {
    handleFrame(data);
  }
};
