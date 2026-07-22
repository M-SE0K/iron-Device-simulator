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
    return { json: JSON.stringify(createErrorMessage(`ff_prot_start_exec 오류: ${err}`)), bin: null };
  }
}

ctx.onmessage = (e: MessageEvent) => {
  const data = e.data as unknown;
  if (typeof data === "string") {
    void handleControl(JSON.parse(data));
    return;
  }
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
