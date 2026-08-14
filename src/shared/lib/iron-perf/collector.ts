// collector.ts — 파이프라인 4개 노드(① ASIO/CoreAudio 네이티브 캡처, ② IPC 스트리밍,
// ③ WASM 엔진, ④ 렌더)의 지연 표본을 스테이지별로 모아 조회 가능한 통계로 만든다.
// index.ts가 이 인스턴스를 window.__ironPerf로 노출한다.
//
// ①/②(Rust/네이티브)는 자기 쪽에서 이미 500ms 창으로 집계(count/avg/min/max)해서 보내므로
// `recordAggregate`로 그 스냅샷을 그대로 반영한다. ③/④(프론트엔드)는 프레임/드로우마다
// 개별 표본을 `record`로 밀어 넣고, 여기서 롤링 윈도우로 통계를 낸다.

const MAX_SAMPLES_PER_STAGE = 500;

export interface PerfSnapshot {
  count: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  /** 샘플 기반 스테이지(③/④)에서만 계산된다 — 집계 전달 스테이지(①/②)엔 없다. */
  p95Ms?: number;
}

type StageEntry =
  | { kind: "samples"; values: number[] }
  | { kind: "aggregate"; value: PerfSnapshot };

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
  private stages = new Map<string, StageEntry>();
  private listeners = new Set<Listener>();

  /** ③(WASM)/④(렌더)처럼 프론트엔드가 직접 개별 표본을 잴 때 쓴다. */
  record(stage: string, ms: number): void {
    let entry = this.stages.get(stage);
    if (!entry || entry.kind !== "samples") {
      entry = { kind: "samples", values: [] };
      this.stages.set(stage, entry);
    }
    entry.values.push(ms);
    if (entry.values.length > MAX_SAMPLES_PER_STAGE) entry.values.shift();
    for (const listener of this.listeners) listener(stage, ms);
  }

  /** ①(ASIO/CoreAudio)/②(IPC)처럼 Rust/네이티브가 이미 집계해 보낸 스냅샷을 그대로 반영한다. */
  recordAggregate(stage: string, snapshot: PerfSnapshot): void {
    this.stages.set(stage, { kind: "aggregate", value: snapshot });
    for (const listener of this.listeners) listener(stage, snapshot.avgMs);
  }

  snapshot(): Record<string, PerfSnapshot> {
    const out: Record<string, PerfSnapshot> = {};
    for (const [stage, entry] of this.stages) {
      if (entry.kind === "aggregate") {
        out[stage] = entry.value;
      } else if (entry.values.length > 0) {
        out[stage] = summarize(entry.values);
      }
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
