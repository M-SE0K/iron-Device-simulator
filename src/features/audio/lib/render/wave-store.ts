import type { SeriesReadBuffer } from "./read-buffer";
import { VersionedSnapshotStore } from "./store-base";

export const MAX_WAVE_BUCKETS = 50000;

const INITIAL_BUCKET_SEC = 0.005;

const SEED_SCAN_LIMIT = 256;


export interface WaveSnapshot {
  version: number;
  bucketCount: number;
  durationSec: number;
  bucketSec: number;
  peak: number;
  rms: number;
  sampleCount: number;
}

export class ChannelWaveStore extends VersionedSnapshotStore<WaveSnapshot> {
  private mins = new Float64Array(MAX_WAVE_BUCKETS);
  private maxs = new Float64Array(MAX_WAVE_BUCKETS);
  private seen = new Uint8Array(MAX_WAVE_BUCKETS);
  private count = 0;

  private initialBucketSec: number;
  private bucketSec: number;
  private durationSec = 0;

  constructor(initialBucketSec: number = INITIAL_BUCKET_SEC) {
    super();
    this.initialBucketSec = initialBucketSec;
    this.bucketSec = initialBucketSec;
  }

  private peakAbs = 0;
  private sumSq = 0;
  private sampleCount = 0;

  addBlock(data: Float32Array, startSec: number, sampleRate: number): void {
    const n = data.length;
    if (n === 0 || !(sampleRate > 0) || !Number.isFinite(startSec)) return;

    const step = 1 / sampleRate;
    const endSec = startSec + (n - 1) * step;
    this.ensureCapacity(endSec);
    const bucketSec = this.bucketSec;

    let peak = this.peakAbs;
    let sumSq = this.sumSq;
    for (let i = 0; i < n; i++) {
      const v = data[i];
      const b = Math.floor((startSec + i * step) / bucketSec);
      if (b >= 0 && b < MAX_WAVE_BUCKETS) {
        if (this.seen[b] === 0) {
          this.mins[b] = v;
          this.maxs[b] = v;
          this.seen[b] = 1;
          if (b >= this.count) this.count = b + 1;
        } else if (v < this.mins[b]) {
          this.mins[b] = v;
        } else if (v > this.maxs[b]) {
          this.maxs[b] = v;
        }
      }
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sumSq += v * v;
    }

    this.peakAbs = peak;
    this.sumSq = sumSq;
    this.sampleCount += n;
    if (endSec + step > this.durationSec) this.durationSec = endSec + step;
    this.dirty = true;
  }

  setInitialBucketSec(sec: number): void {
    this.initialBucketSec = sec;
    this.bucketSec = sec;
  }

  reset(): void {
    this.seen.fill(0);
    this.count = 0;
    this.bucketSec = this.initialBucketSec;
    this.durationSec = 0;
    this.peakAbs = 0;
    this.sumSq = 0;
    this.sampleCount = 0;
    this.dirty = false;
    this.invalidate();
  }

  protected buildSnapshot(): WaveSnapshot {
    return {
      version: this.ver,
      bucketCount: this.count,
      durationSec: this.durationSec,
      bucketSec: this.bucketSec,
      peak: this.peakAbs,
      rms: this.sampleCount > 0 ? Math.sqrt(this.sumSq / this.sampleCount) : 0,
      sampleCount: this.sampleCount,
    };
  }

  readRange(minSec: number, maxSec: number, maxPoints: number, out: SeriesReadBuffer): number {
    const n = this.count;
    if (n === 0) return 0;

    const budget = Math.min(maxPoints, out.xs.length, out.ys.length);
    if (budget < 2) return 0;

    const bucketSec = this.bucketSec;
    let b0 = Number.isFinite(minSec) ? Math.floor(minSec / bucketSec) : 0;
    let b1 = Number.isFinite(maxSec) ? Math.ceil(maxSec / bucketSec) + 1 : n;
    if (b0 < 0) b0 = 0;
    if (b1 > n) b1 = n;
    if (b1 <= b0) return 0;

    const visible = b1 - b0;
    const columns = Math.min(visible, budget >> 1);
    if (columns <= 0) return 0;

    let lastMin = 0;
    let lastMax = 0;
    for (let b = b0 - 1, scanned = 0; b >= 0 && scanned < SEED_SCAN_LIMIT; b--, scanned++) {
      if (this.seen[b] === 1) {
        lastMin = this.mins[b];
        lastMax = this.maxs[b];
        break;
      }
    }

    const duration = this.durationSec;
    let w = 0;
    for (let c = 0; c < columns; c++) {
      const cs = b0 + Math.floor((c * visible) / columns);
      let ce = b0 + Math.floor(((c + 1) * visible) / columns);
      if (ce <= cs) ce = cs + 1;
      if (ce > b1) ce = b1;

      let mn = Infinity;
      let mx = -Infinity;
      for (let b = cs; b < ce; b++) {
        if (this.seen[b] === 0) continue;
        if (this.mins[b] < mn) mn = this.mins[b];
        if (this.maxs[b] > mx) mx = this.maxs[b];
      }
      if (mn === Infinity) {
        mn = lastMin;
        mx = lastMax;
      } else {
        lastMin = mn;
        lastMax = mx;
      }

      const t = cs * bucketSec;
      const mid = t + (ce - cs) * bucketSec * 0.5;
      out.xs[w] = t;
      out.ys[w] = mn;
      w++;
      out.xs[w] = mid > duration ? duration : mid;
      out.ys[w] = mx;
      w++;
    }
    return w;
  }

  valueAt(timeSec: number): number | null {
    if (!(timeSec >= 0) || this.count === 0) return null;
    const b = Math.floor(timeSec / this.bucketSec);
    if (b < 0 || b >= this.count || this.seen[b] === 0) return null;
    return (this.mins[b] + this.maxs[b]) / 2;
  }

  private ensureCapacity(maxTimeSec: number): void {
    if (!(maxTimeSec > 0)) return;
    let guard = 0;
    while (Math.floor(maxTimeSec / this.bucketSec) >= MAX_WAVE_BUCKETS && guard++ < 64) {
      this.compact();
    }
  }

  private compact(): void {
    const src = this.count;
    let w = 0;
    for (let r = 0; r < src; r += 2, w++) {
      const b = r + 1;
      const hasA = this.seen[r] === 1;
      const hasB = b < src && this.seen[b] === 1;
      if (hasA && hasB) {
        this.mins[w] = Math.min(this.mins[r], this.mins[b]);
        this.maxs[w] = Math.max(this.maxs[r], this.maxs[b]);
      } else if (hasA) {
        this.mins[w] = this.mins[r];
        this.maxs[w] = this.maxs[r];
      } else if (hasB) {
        this.mins[w] = this.mins[b];
        this.maxs[w] = this.maxs[b];
      }
      this.seen[w] = hasA || hasB ? 1 : 0;
    }
    this.seen.fill(0, w);
    this.count = w;
    this.bucketSec *= 2;
  }
}
