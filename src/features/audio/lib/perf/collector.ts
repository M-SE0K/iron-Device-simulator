import type {
  PerfExport, PerfFrameSample, PerfRenderSample, PerfSessionMeta, PerfStageStats,
} from "./types";
import { round3 } from "@/shared/lib/utils";

function stageStats(values: number[]): PerfStageStats {
  if (values.length === 0) {
    return { count: 0, avg: null, min: null, max: null, p50: null, p95: null, p99: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    avg: round3(sum / sorted.length),
    min: round3(sorted[0]),
    max: round3(sorted[sorted.length - 1]),
    p50: round3(pct(50)),
    p95: round3(pct(95)),
    p99: round3(pct(99)),
  };
}

class PerfCollector {
  private active = false;
  private meta: PerfSessionMeta | null = null;
  private startedAtIso = "";
  private startedAtPerf = 0;
  private endedAtPerf: number | null = null;
  private frames: PerfFrameSample[] = [];
  private renders: PerfRenderSample[] = [];
  private frameIdx = 0;
  private lastChunkAt = 0;
  private pendingHwCaptureMs: number | null = null;
  private sentQueue: Array<{ hwCaptureMs: number | null; encodingMs: number | null }> = [];

  startSession(meta: PerfSessionMeta): void {
    this.active = true;
    this.meta = meta;
    this.startedAtIso = new Date().toISOString();
    this.startedAtPerf = performance.now();
    this.endedAtPerf = null;
    this.frames = [];
    this.renders = [];
    this.frameIdx = 0;
    this.lastChunkAt = 0;
    this.pendingHwCaptureMs = null;
    this.sentQueue = [];
  }

  endSession(): void {
    if (!this.active) return;
    this.active = false;
    this.endedAtPerf = performance.now();
  }

  isActive(): boolean {
    return this.active;
  }

  markChunkArrival(): void {
    if (!this.active) return;
    const now = performance.now();
    if (this.lastChunkAt > 0) this.pendingHwCaptureMs = round3(now - this.lastChunkAt);
    this.lastChunkAt = now;
  }

  markFrameSent(encodingMs: number | null): void {
    if (!this.active) return;
    this.sentQueue.push({
      hwCaptureMs: this.pendingHwCaptureMs,
      encodingMs: encodingMs !== null ? round3(encodingMs) : null,
    });
    this.pendingHwCaptureMs = null;
  }

  recordFrame(audioTime: number, wasmMs: number, decodingMs: number): void {
    if (!this.active) return;
    const sent = this.sentQueue.shift() ?? { hwCaptureMs: null, encodingMs: null };
    this.frames.push({
      frameIdx: this.frameIdx++,
      audioTime,
      hwCaptureMs: sent.hwCaptureMs,
      encodingMs: sent.encodingMs,
      wasmMs: round3(wasmMs),
      decodingMs: round3(decodingMs),
    });
  }

  recordRender(chart: PerfRenderSample["chart"], renderMs: number): void {
    if (!this.active) return;
    this.renders.push({
      chart,
      at: round3(performance.now() - this.startedAtPerf),
      renderMs: round3(renderMs),
    });
  }

  frameCount(): number {
    return this.frames.length;
  }

  summary(): PerfExport["summary"] {
    const pick = (sel: (f: PerfFrameSample) => number | null) =>
      this.frames.map(sel).filter((v): v is number => v !== null);
    const renderOf = (chart: PerfRenderSample["chart"]) =>
      this.renders.filter((r) => r.chart === chart).map((r) => r.renderMs);
    return {
      hwCapture: stageStats(pick((f) => f.hwCaptureMs)),
      encoding: stageStats(pick((f) => f.encodingMs)),
      wasm: stageStats(pick((f) => f.wasmMs)),
      decoding: stageStats(pick((f) => f.decodingMs)),
      render: {
        temperature: stageStats(renderOf("temperature")),
        excursion: stageStats(renderOf("excursion")),
      },
    };
  }

  export(): PerfExport | null {
    if (!this.meta) return null;
    const endPerf = this.endedAtPerf ?? performance.now();
    return {
      meta: {
        ...this.meta,
        startedAt: this.startedAtIso,
        durationSec: round3((endPerf - this.startedAtPerf) / 1000),
        frameCount: this.frames.length,
      },
      summary: this.summary(),
      frames: this.frames,
      renders: this.renders,
    };
  }

  download(filename?: string): void {
    const data = this.export();
    if (!data || typeof document === "undefined") return;
    const stamp = data.meta.startedAt.replace(/[:.]/g, "-");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename ?? `perf_${data.meta.mode}_${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  reset(): void {
    this.active = false;
    this.meta = null;
    this.frames = [];
    this.renders = [];
    this.frameIdx = 0;
    this.lastChunkAt = 0;
    this.pendingHwCaptureMs = null;
    this.sentQueue = [];
  }
}

export const perf = new PerfCollector();

declare global {
  interface Window {
    __ironPerf?: Pick<
      PerfCollector,
      "isActive" | "frameCount" | "summary" | "export" | "download" | "reset"
    >;
  }
}
if (typeof window !== "undefined") {
  window.__ironPerf = perf;
}
