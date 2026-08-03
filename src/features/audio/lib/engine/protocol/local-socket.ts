import type { EngineParams } from "../../../types";
import { openClientWasmSession } from "../adapters/wasm-client";
import {
  DEFAULT_ENGINE_CONFIG, DEFAULT_AMBIENT_TEMP, frameBytes,
  type AnalysisSession, type EngineRuntimeConfig,
} from "../core";
import {
  parseEngineParams, parseSampleRate, parseSamplesPerCh,
  createReadyMessage, createErrorMessage,
} from "./analysis";
import { processAnalysisFrame } from "./frame-core";
import type { SocketLike } from "./socket-types";
import { WorkerAnalysisSocket } from "./worker-socket";

class LocalWasmSocket implements SocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN       = 1;
  static readonly CLOSING    = 2;
  static readonly CLOSED     = 3;

  readyState = LocalWasmSocket.CONNECTING;
  binaryType = "arraybuffer";
  
  readonly bufferedAmount = 0;

  onopen:    ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror:   ((ev: Event) => void) | null = null;
  onclose:   ((ev: Event) => void) | null = null;

  private session: AnalysisSession | null = null;
  private engineParams: EngineParams = { ampOutputPower: null, speakerModel: "", ambientTemp: DEFAULT_AMBIENT_TEMP };
  private connConfig: EngineRuntimeConfig = DEFAULT_ENGINE_CONFIG;
  private frameCount = 0;
  private initialized = false;

  constructor() {
    queueMicrotask(() => {
      this.readyState = LocalWasmSocket.OPEN;
      this.onopen?.(new Event("open"));
    });
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== LocalWasmSocket.OPEN) return;
    if (typeof data === "string") {
      void this.handleControl(JSON.parse(data));
    } else {
      this.handleFrame(data);
    }
  }

  close(): void {
    if (this.readyState === LocalWasmSocket.CLOSED) return;
    this.readyState = LocalWasmSocket.CLOSED;
    this.session?.close();
    this.session = null;
    this.initialized = false;
    queueMicrotask(() => this.onclose?.(new Event("close")));
  }

  private emit(msg: Record<string, unknown>): void {
    queueMicrotask(() => {
      if (this.readyState === LocalWasmSocket.CLOSED) return;
      this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
    });
  }

  private emitBinary(data: ArrayBuffer): void {
    queueMicrotask(() => {
      if (this.readyState === LocalWasmSocket.CLOSED) return;
      this.onmessage?.({ data } as MessageEvent);
    });
  }

  private async handleControl(msg: { type: string } & Record<string, unknown>): Promise<void> {
    if (msg.type === "init") {
      if (this.initialized) {
        this.emit(createReadyMessage());
        return;
      }

      this.engineParams = parseEngineParams(msg);
      this.connConfig = {
        sampleRate: parseSampleRate(msg),
        samplesPerCh: parseSamplesPerCh(msg),
      };

      try {
        // 이 클래스는 항상 메인 스레드에서만 생성된다(Worker 경로는 WorkerAnalysisSocket) —
        // window.wasmAsset(Tauri IPC, 암호화 WASM 복호화)에 직접 접근해도 안전하다.
        const wasmBinary = typeof window !== "undefined"
          ? await window.wasmAsset?.loadEngineBinary()
          : undefined;
        this.session = await openClientWasmSession(this.connConfig, { includeProcessedPcm: true }, wasmBinary);
      } catch (err) {
        this.emit(createErrorMessage(String(err)));
        return;
      }

      this.initialized = true;
      this.frameCount  = 0;
      this.emit(createReadyMessage());

    } else if (msg.type === "stop") {
      this.session?.close();
      this.session = null;
      this.initialized = false;
    }
  }

  private handleFrame(data: ArrayBuffer): void {
    if (!this.initialized || !this.session) return;
    if (data.byteLength < frameBytes(this.connConfig)) return;

    const currentFrame = this.frameCount++;

    try {
      const out = processAnalysisFrame(this.session, data, this.engineParams, this.connConfig, currentFrame);
      if (!out) return;
      this.emit(out.frameJson as Record<string, unknown>);
      if (out.binary) this.emitBinary(out.binary);
    } catch (err) {
      this.emit(createErrorMessage(`ff_prot_start_exec error: ${err}`));
    }
  }
}

export function createAnalysisSocket(): SocketLike {
  if (process.env.USE_WORKER_ENGINE === "0") {
    return new LocalWasmSocket();
  }
  try {
    return new WorkerAnalysisSocket();
  } catch (err) {
    console.warn("Web Worker 분석 엔진 생성 실패 — 메인 스레드 엔진으로 폴백합니다.", err);
    return new LocalWasmSocket();
  }
}
