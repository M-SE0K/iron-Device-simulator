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

const ctx = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

let session: AnalysisSession | null = null;
let engineParams: EngineParams = { ampOutputPower: null, speakerModel: "", ambientTemp: DEFAULT_AMBIENT_TEMP };
let config: EngineRuntimeConfig = DEFAULT_ENGINE_CONFIG;
// ⚠️ frameCount는 **도착한 모든 프레임**이 소비한다(엔진 준비 전에 버린 것 포함) — 이 번호가
// 그대로 frame 메시지의 time과 보호 감쇠 PCM의 위치가 되므로 재생 시작으로부터의 절대 위치여야
// 한다. init에서 0으로 되돌리지 않는다. 워커는 세션마다 새로 생성되므로(WorkerAnalysisSocket의
// 생성자가 new Worker) 모듈 스코프 초기화만으로 충분하다.
let frameCount = 0;
let warmupDroppedFrames = 0;
let initialized = false;

function postJson(msg: unknown): void {
  ctx.postMessage(JSON.stringify(msg));
}

interface FrameResultItem { json: string; bin: ArrayBuffer | null }

async function handleControl(
  msg: { type: string } & Record<string, unknown>,
  wasmBinary?: Uint8Array<ArrayBuffer>,
): Promise<void> {
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
      // wasmBinary는 메인 스레드(worker-socket.ts)가 window.wasmAsset(Tauri IPC)로 미리
      // 복호화해 init 메시지에 실어 보낸 것 — 이 파일(워커)은 window를 참조하지 않는다.
      session = await openClientWasmSession(config, { includeProcessedPcm: true }, wasmBinary);
    } catch (err) {
      postJson(createErrorMessage(String(err)));
      return;
    }

    initialized = true;
    postJson(createReadyMessage(warmupDroppedFrames));

  } else if (msg.type === "stop") {
    session?.close();
    session = null;
    initialized = false;
  }
}

function handleFrame(data: ArrayBuffer): FrameResultItem | null {
  if (data.byteLength < frameBytes(config)) return null;

  // local-socket.ts의 handleFrame과 같은 규약 — 준비 전 프레임도 번호는 소비하고 버린다.
  const currentFrame = frameCount++;

  if (!initialized || !session) {
    warmupDroppedFrames++;
    return null;
  }

  try {
    const out = processAnalysisFrame(session, data, engineParams, config, currentFrame);
    if (!out) return null;
    return { json: JSON.stringify(out.frameJson), bin: out.binary ?? null };
  } catch (err) {
    return { json: JSON.stringify(createErrorMessage(`ff_prot_start_exec error: ${err}`)), bin: null };
  }
}

ctx.onmessage = (e: MessageEvent) => {
  const data = e.data as unknown;
  if (typeof data === "string") {
    void handleControl(JSON.parse(data));
    return;
  }
  if (data && typeof data === "object" && (data as { type?: unknown }).type === "init") {
    // worker-socket.ts(메인 스레드)가 "init" 컨트롤 메시지만 이 형태로 감싸 보낸다 —
    // 암호화 WASM 바이너리(window.wasmAsset로 미리 복호화)를 함께 실어 나르기 위함.
    const envelope = data as { initPayload: { type: string } & Record<string, unknown>; wasmBinary?: Uint8Array<ArrayBuffer> };
    void handleControl(envelope.initPayload, envelope.wasmBinary);
    return;
  }
  if (data && typeof data === "object" && Array.isArray((data as { frames?: unknown }).frames)) {
    // sentAt은 E2E 지연 실험(N3/N7, src/features/audio/lib/perf-e2e/)이 켜졌을 때만 실려온다 —
    // 없으면 응답에 타임스탬프 필드를 붙이지 않을 뿐, workerRecvAt 기록 자체는 항상 실행된다.
    // 워커는 자체 e2e 컬렉터 인스턴스를 갖지 않는다(별도 JS
    // 렐름이라 메인 스레드의 window.__ironE2E와 상태가 공유되지 않으므로) — 타임스탬프만 echo하고
    // 실제 기록은 이 메시지를 받는 worker-socket.ts(메인 스레드)가 한다.
    // 반드시 Date.now()(벽시계) — Worker의 performance.now()는 "이 Worker가 생성된 시점" 기준이라
    // 메인 스레드(worker-socket.ts의 sentAt/mainRecvAt)와 시간 원점이 다르다. 섞어 쓰면 차이가
    // Date.now()의 절대값 규모(±1.78e12ms)로 튄다.
    const workerRecvAt = Date.now();
    const envelope = data as { frames: ArrayBuffer[]; sentAt?: number };
    const frames = envelope.frames;
    const results: FrameResultItem[] = [];
    const transfer: Transferable[] = [];
    for (const buf of frames) {
      const item = handleFrame(buf);
      if (!item) continue;
      results.push(item);
      if (item.bin) transfer.push(item.bin);
    }
    if (results.length > 0) {
      const payload: { results: FrameResultItem[]; sentAt?: number; workerRecvAt?: number; workerDoneAt?: number } = { results };
      if (envelope.sentAt !== undefined) {
        payload.sentAt = envelope.sentAt;
        payload.workerRecvAt = workerRecvAt;
        payload.workerDoneAt = Date.now();
      }
      ctx.postMessage(payload, transfer);
    }
  }
};
