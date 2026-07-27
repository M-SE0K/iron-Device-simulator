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

export function envelopeToSeries(env: BucketEnvelope, durationSec: number): [number, number][] {
  const dt = durationSec / env.buckets;
  const out: [number, number][] = [];
  for (let b = 0; b <= env.filledUpTo; b++) {
    if (env.seen[b] === 0) continue;
    const t = b * dt;
    out.push([t, env.min[b]], [t + dt * 0.5, env.max[b]]);
  }
  return out;
}
