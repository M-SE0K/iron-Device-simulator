import { clear } from "console";

export interface WorkerInitPayload {
  ampOutputPower: string;
  speakerModel: string;
  sampleRate?: number;
}

export type MainToWorkerMessage =
  | { type: "connect"; wsUrl: string; initPayload: WorkerInitPayload }
  | {
      type: "init-file";
      pcmBuffer: ArrayBuffer;
      sampleRate: number;
      samplesPerCh: number;
      frameBytes: number;
      totalFrames: number;
    }
  | { type: "play"; startOffsetSec: number; playbackBasePerfMs: number }
  | { type: "pause"; pausedAtSec: number }
  | { type: "stop" }
  | { type: "sync-clock"; currentTimeSec: number; performanceNowMs: number }
  | { type: "send-json"; message: object }
  | { type: "mic-frame"; buffer: ArrayBuffer };

export type WorkerToMainMessage =
  | { type: "ready" }
  | {
      type: "frame";
      frameIdx: number;
      time: number;
      temperature: [number, number];
      excursion: [number, number];
      processingMs: number;
      rttMs: number | null;
      receivedAt: number;
    }
  | {
      type: "stats";
      connected: boolean;
      ready: boolean;
      framesSent: number;
      framesReceived: number;
      sendRateFps: number | null;
      latestRttMs: number | null;
      avgRttMs: number | null;
      minRttMs: number | null;
      maxRttMs: number | null;
      serverProcessingMs: number | null;
    }
  | { type: "closed" }
  | { type: "error"; message: string };