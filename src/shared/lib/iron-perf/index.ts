import { ironPerfCollector } from "./collector";

export function recordPerfSample(stage: string, ms: number): void {
  if (process.env.NEXT_PUBLIC_IRON_PERF !== "1") return;
  ironPerfCollector.record(stage, ms);
}

let initialized = false;

export function initIronPerf(): void {
  if (process.env.NEXT_PUBLIC_IRON_PERF !== "1" || typeof window === "undefined") return;
  if (initialized) return;
  initialized = true;

  (window as unknown as { __ironPerf: unknown }).__ironPerf = {
    snapshot: () => ironPerfCollector.snapshot(),
    reset: () => ironPerfCollector.reset(),
    subscribe: (fn: (stage: string, ms: number) => void) => ironPerfCollector.subscribe(fn),
  };
}
