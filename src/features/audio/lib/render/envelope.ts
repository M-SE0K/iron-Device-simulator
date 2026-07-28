export class BucketEnvelope {
  readonly min: Float32Array;
  readonly max: Float32Array;
  readonly seen: Uint8Array;
  filledUpTo = -1;

  constructor(readonly buckets: number) {
    this.min = new Float32Array(buckets);
    this.max = new Float32Array(buckets);
    this.seen = new Uint8Array(buckets);
  }

  add(bucket: number, v: number) {
    if (bucket < 0 || bucket >= this.buckets) return;
    if (this.seen[bucket] === 0) {
      this.min[bucket] = v;
      this.max[bucket] = v;
      this.seen[bucket] = 1;
      if (bucket > this.filledUpTo) this.filledUpTo = bucket;
      return;
    }
    if (v < this.min[bucket]) this.min[bucket] = v;
    else if (v > this.max[bucket]) this.max[bucket] = v;
  }

  clear() {
    this.seen.fill(0);
    this.filledUpTo = -1;
  }

  peak(): number {
    let peak = 0;
    for (let b = 0; b <= this.filledUpTo; b++) {
      if (this.seen[b] === 0) continue;
      const a = Math.max(Math.abs(this.min[b]), Math.abs(this.max[b]));
      if (a > peak) peak = a;
    }
    return peak;
  }
}

/**
 * 같은 버킷 수/길이를 공유하는 엔벨로프들을 uPlot 컬럼(aligned) 데이터로 만든다 —
 * x는 버킷당 2점(min이 t, max가 t+dt/2)의 공통 격자, 아직 채워지지 않은 버킷은 null.
 */
export function envelopesToAligned(
  envs: BucketEnvelope[],
  durationSec: number,
): [Float64Array, ...(number | null)[][]] {
  const buckets = envs[0]?.buckets ?? 0;
  const dt = durationSec / buckets;
  const xs = new Float64Array(buckets * 2);
  for (let b = 0; b < buckets; b++) {
    xs[b * 2] = b * dt;
    xs[b * 2 + 1] = b * dt + dt * 0.5;
  }
  const cols = envs.map((env) => {
    const ys: (number | null)[] = new Array(buckets * 2).fill(null);
    for (let b = 0; b <= env.filledUpTo; b++) {
      if (env.seen[b] === 0) continue;
      ys[b * 2] = env.min[b];
      ys[b * 2 + 1] = env.max[b];
    }
    return ys;
  });
  return [xs, ...cols];
}
