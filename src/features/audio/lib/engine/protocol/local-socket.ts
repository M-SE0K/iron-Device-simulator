import type { EngineParams } from "@/features/audio/types";
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
  // ⚠️ frameCount는 **도착한 모든 프레임**이 소비한다(엔진 준비 전에 버린 것 포함). 이 번호가
  // 그대로 frame 메시지의 time(analysis.ts)과 보호 감쇠 PCM의 위치가 되므로, 재생 시작으로부터의
  // 절대 위치여야 한다. 그래서 init 시점에 0으로 되돌리지 않는다 — 소켓은 세션마다 새로
  // 만들어지므로(createAnalysisSocket) 선언 시 초기화만으로 충분하다.
  private frameCount = 0;
  private warmupDroppedFrames = 0;
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
      this.emit(createReadyMessage(this.warmupDroppedFrames));

    } else if (msg.type === "stop") {
      this.session?.close();
      this.session = null;
      this.initialized = false;
    }
  }

  private handleFrame(data: ArrayBuffer): void {
    if (data.byteLength < frameBytes(this.connConfig)) return;

    // 준비 여부와 무관하게 번호를 먼저 소비한다. 예전엔 준비 전 프레임을 번호도 안 세고 버린
    // 뒤 준비 시점에 frameCount를 0으로 되돌려서, frameIndex=0이 실제로는 "재생이 이미
    // warmupDroppedFrames만큼 진행된 지점"의 오디오를 가리켰다 — 그만큼 온도/변위 차트와
    // Input/Protected 파형이 통째로 앞당겨져 그려졌다.
    const currentFrame = this.frameCount++;

    if (!this.initialized || !this.session) {
      this.warmupDroppedFrames++;
      return;
    }

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
