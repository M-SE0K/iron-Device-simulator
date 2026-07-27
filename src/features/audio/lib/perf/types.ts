export interface PerfFrameSample {
  frameIdx: number;
  audioTime: number;
  hwCaptureMs: number | null;
  encodingMs: number | null;
  wasmMs: number;
  decodingMs: number;
}

export interface PerfRenderSample {
  chart: "temperature" | "excursion";
  at: number;
  renderMs: number;
}

export type PerfStageStats = StatBlock;

export interface PerfSessionMeta {
  mode: "native" | "web";
  sampleRate: number;
  samplesPerCh: number;
  channels: number;
  deviceName: string | null;
}

export interface PerfExport {
  meta: PerfSessionMeta & {
    startedAt: string;
    durationSec: number;
    frameCount: number;
  };
  summary: {
    hwCapture: PerfStageStats;
    encoding: PerfStageStats;
    wasm: PerfStageStats;
    decoding: PerfStageStats;
    render: { temperature: PerfStageStats; excursion: PerfStageStats };
  };
  frames: PerfFrameSample[];
  renders: PerfRenderSample[];
}
import type { StatBlock } from "./statistics";
