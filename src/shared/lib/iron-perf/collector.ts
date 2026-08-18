const MAX_SAMPLES_PER_STAGE = 500;

interface PerfSnapshot {
  count: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
}

type Listener = (stage: string, ms: number) => void;

function summarize(values: number[]): PerfSnapshot {
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p95Index = Math.min(count - 1, Math.floor(count * 0.95));
  return {
    count,
    avgMs: sum / count,
    minMs: sorted[0],
    maxMs: sorted[count - 1],
    p95Ms: sorted[p95Index],
  };
}

class PerfCollector {
  private stages = new Map<string, number[]>();
  private listeners = new Set<Listener>();

  record(stage: string, ms: number): void {
    let values = this.stages.get(stage);
    if (!values) {
      values = [];
      this.stages.set(stage, values);
    }
    values.push(ms);
    if (values.length > MAX_SAMPLES_PER_STAGE) values.shift();
    for (const listener of this.listeners) listener(stage, ms);
  }

  snapshot(): Record<string, PerfSnapshot> {
    const out: Record<string, PerfSnapshot> = {};
    for (const [stage, values] of this.stages) {
      if (values.length > 0) out[stage] = summarize(values);
    }
    return out;
  }

  reset(): void {
    this.stages.clear();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const ironPerfCollector = new PerfCollector();
