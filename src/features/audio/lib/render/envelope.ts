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

export type EnvelopeColumn = (number | null)[];

export function buildBucketXs(buckets: number, durationSec: number): Float64Array {
  const xs = new Float64Array(buckets * 2);
  const dt = durationSec / buckets;
  for (let b = 0; b < buckets; b++) {
    xs[b * 2] = b * dt;
    xs[b * 2 + 1] = b * dt + dt * 0.5;
  }
  return xs;
}

export function emptyEnvelopeColumn(buckets: number): EnvelopeColumn {
  return new Array<number | null>(buckets * 2).fill(null);
}

export function fillEnvelopeColumn(env: BucketEnvelope, out?: EnvelopeColumn): EnvelopeColumn {
  const ys: EnvelopeColumn = out ?? emptyEnvelopeColumn(env.buckets);
  for (let b = 0; b <= env.filledUpTo; b++) {
    if (env.seen[b] === 0) continue;
    ys[b * 2] = env.min[b];
    ys[b * 2 + 1] = env.max[b];
  }
  return ys;
}
