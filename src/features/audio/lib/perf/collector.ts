import type {
  PerfExport, PerfFrameSample, PerfRenderSample, PerfSessionMeta,
} from "./types";
import { downloadJsonArtifact, round3 } from "@/shared/lib/utils";
import { summarizeStats } from "./statistics";

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
      hwCapture: summarizeStats(pick((f) => f.hwCaptureMs)),
      encoding: summarizeStats(pick((f) => f.encodingMs)),
      wasm: summarizeStats(pick((f) => f.wasmMs)),
      decoding: summarizeStats(pick((f) => f.decodingMs)),
      render: {
        temperature: summarizeStats(renderOf("temperature")),
        excursion: summarizeStats(renderOf("excursion")),
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
    if (!data) return;
    downloadJsonArtifact(data, "perf", data.meta, filename);
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
