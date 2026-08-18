import type { EngineFrameMessage, EngineMessage } from "../../../types";
import {
  EngineSessionCore,
  type EngineInitPayload,
  type EngineOutput,
  type WorkerRequest,
  type WorkerResponse,
} from "./session-core";
import type { ProtectedPcm } from "./frame-core";

export interface EngineClient {
  readonly closed: boolean;
  onReady: ((warmupDroppedFrames: number) => void) | null;
  onFrame: ((frame: EngineFrameMessage) => void) | null;
  onProtectedPcm: ((pcm: ProtectedPcm) => void) | null;
  onError: ((message: string) => void) | null;
  onTransportError: (() => void) | null;
  init(payload: EngineInitPayload): void;
  sendFrame(data: ArrayBuffer): void;
  stop(): void;
}

function routeMessage(client: EngineClient, msg: EngineMessage): void {
  switch (msg.type) {
    case "ready":
      client.onReady?.(msg.warmupDroppedFrames ?? 0);
      break;
    case "frame":
      client.onFrame?.(msg);
      break;
    case "error":
      client.onError?.(msg.message);
      break;
  }
}

class LocalEngineClient implements EngineClient {
  closed = false;
  onReady: EngineClient["onReady"] = null;
  onFrame: EngineClient["onFrame"] = null;
  onProtectedPcm: EngineClient["onProtectedPcm"] = null;
  onError: EngineClient["onError"] = null;
  onTransportError: EngineClient["onTransportError"] = null;

  private readonly core = new EngineSessionCore();

  init(payload: EngineInitPayload): void {
    void this.core.init(payload).then((msg) => this.deliver({ msg, pcm: null }));
  }

  sendFrame(data: ArrayBuffer): void {
    if (this.closed) return;
    const out = this.core.processFrame(data);
    if (out) this.deliver(out);
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.core.stop();
  }

  private deliver(out: EngineOutput): void {
    queueMicrotask(() => {
      if (this.closed) return;
      routeMessage(this, out.msg);
      if (out.pcm) this.onProtectedPcm?.(out.pcm);
    });
  }
}

class WorkerEngineClient implements EngineClient {
  closed = false;
  onReady: EngineClient["onReady"] = null;
  onFrame: EngineClient["onFrame"] = null;
  onProtectedPcm: EngineClient["onProtectedPcm"] = null;
  onError: EngineClient["onError"] = null;
  onTransportError: EngineClient["onTransportError"] = null;

  private readonly worker: Worker;
  private pendingFrames: ArrayBuffer[] = [];
  private flushScheduled = false;
  private initPosted = false;

  constructor() {
    this.worker = new Worker(new URL("../worker/dsp-worker.ts", import.meta.url));

    this.worker.onmessage = (e: MessageEvent) => {
      if (this.closed) return;
      const data = e.data as WorkerResponse;
      if (!data || !Array.isArray(data.results)) return;
      for (const out of data.results) {
        routeMessage(this, out.msg);
        if (out.pcm) this.onProtectedPcm?.(out.pcm);
      }
    };

    this.worker.onerror = () => {
      if (this.closed) return;
      this.onTransportError?.();
    };
  }

  init(payload: EngineInitPayload): void {
    void this.postInit(payload);
  }

  private async postInit(payload: EngineInitPayload): Promise<void> {
    let wasmBinary: Uint8Array<ArrayBuffer> | undefined;
    try {
      wasmBinary = typeof window !== "undefined"
        ? await window.wasmAsset?.loadEngineBinary()
        : undefined;
    } catch (err) {
      if (this.closed) return;
      this.pendingFrames = [];
      console.warn("[engine] WASM 엔진 바이너리 복호화 실패:", err);
      this.onTransportError?.();
      return;
    }
    if (this.closed) return;
    const request: WorkerRequest = { type: "init", payload, wasmBinary };
    if (wasmBinary) {
      this.worker.postMessage(request, [wasmBinary.buffer]);
    } else {
      this.worker.postMessage(request);
    }
    this.initPosted = true;
    this.flushFrames();
  }

  sendFrame(data: ArrayBuffer): void {
    if (this.closed) return;
    this.pendingFrames.push(data);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flushFrames());
    }
  }

  private flushFrames(): void {
    this.flushScheduled = false;
    if (!this.initPosted || this.pendingFrames.length === 0) return;
    const frames = this.pendingFrames;
    this.pendingFrames = [];
    const request: WorkerRequest = { type: "frames", frames };
    this.worker.postMessage(request, frames);
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingFrames = [];
    try {
      const request: WorkerRequest = { type: "stop" };
      this.worker.postMessage(request);
    } catch {
    }
    this.worker.terminate();
  }
}

export function createEngineClient(): EngineClient {
  try {
    return new WorkerEngineClient();
  } catch (err) {
    console.warn("Web Worker 분석 엔진 생성 실패 — 메인 스레드 엔진으로 폴백합니다.", err);
    return new LocalEngineClient();
  }
}
