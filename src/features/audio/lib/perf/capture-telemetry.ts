import { perf } from "./collector";
import { e2e } from "../perf-e2e/collector";

interface CaptureTelemetryOptions<T> {
  mode: "native" | "web";
  sampleRate: number;
  samplesPerCh: number;
  channels: number;
  deviceName: string | null;
  onEncodedFrame: (frame: T) => void;
}

export function createCaptureTelemetry<T>({
  mode,
  sampleRate,
  samplesPerCh,
  channels,
  deviceName,
  onEncodedFrame,
}: CaptureTelemetryOptions<T>) {
  perf.startSession({ mode, sampleRate, samplesPerCh, channels, deviceName });
  e2e.startSession({
    mode,
    sampleRate,
    samplesPerCh,
    channels,
    deviceName,
    engine: process.env.USE_WORKER_ENGINE === "0" ? "main-thread" : "worker",
  });

  let encodingStartedAt = 0;

  const markChunkArrival = () => {
    perf.markChunkArrival();
    encodingStartedAt = performance.now();
  };

  const measureEncoding = <R>(encode: () => R): R => e2e.time("N2", encode);

  const markEncodedFrame = (frame: T) => {
    perf.markFrameSent(encodingStartedAt > 0 ? performance.now() - encodingStartedAt : null);
    onEncodedFrame(frame);
  };

  return { markChunkArrival, measureEncoding, markEncodedFrame };
}
