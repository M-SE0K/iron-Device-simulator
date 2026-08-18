import type { EngineMessage, EngineParams } from "../../../types";
import { openClientWasmSession } from "../adapters/wasm-client";
import {
  DEFAULT_ENGINE_CONFIG, DEFAULT_AMBIENT_TEMP, frameBytes,
  type AnalysisSession, type EngineRuntimeConfig,
} from "../core";
import {
  parseEngineParams, parseSampleRate, parseSamplesPerCh,
  createReadyMessage, createErrorMessage,
  type EngineInitPayload,
} from "./analysis";
import { processAnalysisFrame, type ProtectedPcm } from "./frame-core";

export type { EngineInitPayload };

export interface EngineOutput {
  msg: EngineMessage;
  pcm: ProtectedPcm | null;
}

export type WorkerRequest =
  | { type: "init"; payload: EngineInitPayload; wasmBinary?: Uint8Array<ArrayBuffer> }
  | { type: "frames"; frames: ArrayBuffer[] }
  | { type: "stop" };

export interface WorkerResponse {
  results: EngineOutput[];
}

export class EngineSessionCore {
  private session: AnalysisSession | null = null;
  private engineParams: EngineParams = { ambientTemp: DEFAULT_AMBIENT_TEMP };
  private config: EngineRuntimeConfig = DEFAULT_ENGINE_CONFIG;
  private frameCount = 0;
  private warmupDroppedFrames = 0;
  private initialized = false;

  async init(payload: EngineInitPayload, wasmBinary?: Uint8Array<ArrayBuffer>): Promise<EngineMessage> {
    if (this.initialized) return createReadyMessage();

    this.engineParams = parseEngineParams(payload);
    this.config = {
      sampleRate: parseSampleRate(payload),
      samplesPerCh: parseSamplesPerCh(payload),
    };

    try {
      this.session = await openClientWasmSession(this.config, wasmBinary);
    } catch (err) {
      return createErrorMessage(String(err));
    }

    this.initialized = true;
    return createReadyMessage(this.warmupDroppedFrames);
  }

  stop(): void {
    this.session?.close();
    this.session = null;
    this.initialized = false;
  }

  processFrame(data: ArrayBuffer): EngineOutput | null {
    if (data.byteLength < frameBytes(this.config)) return null;

    const currentFrame = this.frameCount++;

    if (!this.initialized || !this.session) {
      this.warmupDroppedFrames++;
      return null;
    }

    try {
      const out = processAnalysisFrame(this.session, data, this.engineParams, this.config, currentFrame);
      if (!out) return null;
      return { msg: out.frame, pcm: out.pcm };
    } catch (err) {
      return { msg: createErrorMessage(`ff_prot_start_exec error: ${err}`), pcm: null };
    }
  }
}
