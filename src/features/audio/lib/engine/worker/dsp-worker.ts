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
let frameCount = 0;
let initialized = false;

function postJson(msg: unknown): void {
  ctx.postMessage(JSON.stringify(msg));
}

interface FrameResultItem { json: string; bin: ArrayBuffer | null }

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
}

function handleFrame(data: ArrayBuffer): FrameResultItem | null {
  if (!initialized || !session) return null;
  if (data.byteLength < frameBytes(config)) return null;

  const currentFrame = frameCount++;
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
