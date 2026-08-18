import type { EngineFrameMessage, EngineMessage } from "../../../types";
import { isIronPerfEnabled, recordPerfSample } from "@/shared/lib/iron-perf";
import {
  EngineSessionCore,
  type EngineInitPayload,
  type EngineOutput,
  type WorkerRequest,
  type WorkerResponse,
} from "./session-core";
import type { ProtectedPcm } from "./frame-core";

/* worker_roundtrip: sendFrame() 호출부터 해당 프레임 결과가 메인 스레드에 돌아올 때까지.
 * wasm_engine(워커 안쪽 analyze 시간)과의 차 = 워커 래퍼 오버헤드(직렬화/전송/큐 대기 +
 * frame-core 의 slice/deinterleave). 스탬프는 전송 순서와 1:1 정렬되며, 워밍업으로
 * 버려진 프레임 수는 ready 메시지가 알려줘 그만큼 앞에서 걷어낸다. */
const ROUNDTRIP_STAMP_CAP = 4096;

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
  private readonly perfEnabled = isIronPerfEnabled();
  private roundtripStamps: number[] = [];

  constructor() {
    this.worker = new Worker(new URL("../worker/dsp-worker.ts", import.meta.url));

    this.worker.onmessage = (e: MessageEvent) => {
      if (this.closed) return;
      const data = e.data as WorkerResponse;
      if (!data || !Array.isArray(data.results)) return;
      for (const out of data.results) {
        if (this.perfEnabled) this.trackRoundtrip(out.msg);
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
    if (this.perfEnabled && this.roundtripStamps.length < ROUNDTRIP_STAMP_CAP) {
      this.roundtripStamps.push(performance.now());
    }
    this.pendingFrames.push(data);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flushFrames());
    }
  }

  /* frame/error 결과는 sendFrame 1건에 대한 응답이라 스탬프를 하나 소비한다.
   * ready 는 init 응답이므로 소비하지 않되, 워밍업 드롭 수만큼 응답 없는 스탬프를 걷어낸다. */
  private trackRoundtrip(msg: EngineMessage): void {
    if (msg.type === "ready") {
      const dropped = msg.warmupDroppedFrames ?? 0;
      if (dropped > 0) this.roundtripStamps.splice(0, dropped);
      return;
    }
    const t0 = this.roundtripStamps.shift();
    if (t0 !== undefined && msg.type === "frame") {
      recordPerfSample("worker_roundtrip", performance.now() - t0);
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
