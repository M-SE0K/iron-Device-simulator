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
 * 프로토콜(메인 → 워커):
 *   string(JSON)         { type: 'init' | 'stop', ... }     제어 메시지
 *   { frames: [...] }    PCM 프레임 배치(모든 버퍼 transfer)  한 청크치 와이어 프레임 묶음
 * 프로토콜(워커 → 메인):
 *   string(JSON)         ready / error                       (worker-socket이 그대로 중계)
 *   { results: [...] }   프레임별 { json, bin } 배치           (worker-socket이 프레임별로 풂)
 *
 * 배치(Stage 1): 메인이 한 청크의 프레임들을 {frames:[…]}로 한 번에 보내고, 워커는 각각
 * 분석해 결과를 {results:[…]}로 한 번에 돌려준다 — 고레이트(작은 버퍼)에서 폭증하던
 * postMessage 왕복을 프레임당 → 청크당으로 줄인다. 프레임 처리·인코딩은 그대로다.
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

/** ready/error 제어 메시지는 문자열로 보낸다 — worker-socket이 그대로 중계, 소비자가 JSON.parse. */
function postJson(msg: unknown): void {
  ctx.postMessage(JSON.stringify(msg));
}

/** 워커→메인 배치 결과 한 항목 — frameJson(문자열) + 보호 PCM(있으면). */
interface FrameResultItem { json: string; bin: ArrayBuffer | null }

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

// ── PCM 프레임 1개 처리 — LocalWasmSocket.handleFrame 이식. 결과를 배치 항목으로 돌려준다. ──
function handleFrame(data: ArrayBuffer): FrameResultItem | null {
  if (!initialized || !session) return null;
  // 와이어 크기 미만이면 프레임 인덱스를 소비하지 않고 버린다(짧은/깨진 프레임).
  if (data.byteLength < frameBytes(config)) return null;

  const currentFrame = frameCount++;
  try {
    const out = processAnalysisFrame(session, data, engineParams, config, currentFrame);
    if (!out) return null;
    // frameJson은 여기서 문자열화한다 — worker-socket이 문자열 그대로 소비자에 넘겨 JSON.parse된다.
    return { json: JSON.stringify(out.frameJson), bin: out.binary ?? null };
  } catch (err) {
    return { json: JSON.stringify(createErrorMessage(`ff_prot_start_exec 오류: ${err}`)), bin: null };
  }
}

ctx.onmessage = (e: MessageEvent) => {
  const data = e.data as unknown;
  if (typeof data === "string") {
    void handleControl(JSON.parse(data));
    return;
  }
  // 프레임 배치({frames:[…]}) — 각 프레임을 분석해 결과를 하나의 배치로 되돌린다.
  if (data && typeof data === "object" && Array.isArray((data as { frames?: unknown }).frames)) {
    const frames = (data as { frames: ArrayBuffer[] }).frames;
    const results: FrameResultItem[] = [];
    const transfer: Transferable[] = [];
    for (const buf of frames) {
      const item = handleFrame(buf);
      if (!item) continue;
      results.push(item);
      if (item.bin) transfer.push(item.bin);
    }
    if (results.length > 0) ctx.postMessage({ results }, transfer);
  }
};
