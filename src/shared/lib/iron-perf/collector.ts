/* 스테이지별 샘플 링버퍼 수집기. 예전 구현은 스테이지당 500샘플 고정이라 100Hz급
 * 스테이지(wasm_engine 등)는 최근 5초 창밖에 못 봤다 — 4096샘플 링(100Hz 기준 ~40초)
 * 으로 키우고, shift() O(n) 대신 커서 순환으로 기록 비용을 상수화한다.
 * 값의 단위는 스테이지가 정한다: *_ms 통계 필드 이름을 쓰지만 stream_lead 등
 * 게이지(프레임 수) 스테이지도 같은 통계 구조를 재사용한다. */
const RING_CAPACITY = 4096;

interface PerfSnapshot {
  count: number;      // 창(링) 안의 샘플 수
  totalCount: number; // 세션 누적 기록 횟수 (창 밖으로 밀려난 것 포함)
  avgMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
}

type Listener = (stage: string, ms: number) => void;

class StageRing {
  private readonly buf = new Float64Array(RING_CAPACITY);
  private next = 0;
  private filled = 0;
  private total = 0;

  push(v: number): void {
    this.buf[this.next] = v;
    this.next = (this.next + 1) % RING_CAPACITY;
    if (this.filled < RING_CAPACITY) this.filled++;
    this.total++;
  }

  snapshot(): PerfSnapshot | null {
    const n = this.filled;
    if (n === 0) return null;
    const sorted = new Float64Array(n);
    if (n < RING_CAPACITY) {
      sorted.set(this.buf.subarray(0, n));
    } else {
      sorted.set(this.buf);
    }
    sorted.sort();
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sorted[i];
    const p95Index = Math.min(n - 1, Math.floor(n * 0.95));
    return {
      count: n,
      totalCount: this.total,
      avgMs: sum / n,
      minMs: sorted[0],
      maxMs: sorted[n - 1],
      p95Ms: sorted[p95Index],
    };
  }
}

class PerfCollector {
  private stages = new Map<string, StageRing>();
  private listeners = new Set<Listener>();

  record(stage: string, ms: number): void {
    let ring = this.stages.get(stage);
    if (!ring) {
      ring = new StageRing();
      this.stages.set(stage, ring);
    }
    ring.push(ms);
    for (const listener of this.listeners) listener(stage, ms);
  }

  snapshot(): Record<string, PerfSnapshot> {
    const out: Record<string, PerfSnapshot> = {};
    for (const [stage, ring] of this.stages) {
      const snap = ring.snapshot();
      if (snap) out[stage] = snap;
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
