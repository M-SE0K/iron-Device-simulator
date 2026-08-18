import type { AnalysisFrame } from "@/features/audio/types";
import type { SeriesReadBuffer } from "./read-buffer";
import { VersionedSnapshotStore } from "./store-base";

const MAX_CHART_POINTS = 30000;

export type ChartMetric = "temperature" | "excursion";

export interface ChartSnapshot {
  version: number;
  count: number;
  lastTemperature: number | null;
  lastExcursion: number | null;
  tempMin: number;
  tempMax: number;
  excMin: number;
  excMax: number;
  sourceCount: number;
  pointInterval: number;
  firstX: number | null;
  lastX: number | null;
}

function lowerBound(arr: Float64Array, n: number, value: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(arr: Float64Array, n: number, value: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class ChartStore extends VersionedSnapshotStore<ChartSnapshot> {
  private xs = new Float64Array(MAX_CHART_POINTS);
  private temps = new Float64Array(MAX_CHART_POINTS);
  private excs = new Float64Array(MAX_CHART_POINTS);
  private count = 0;

  private bucketSec = 0;
  private bucketStart = 0;
  private minDelta = Infinity;

  private srcCount = 0;
  private tMin = Infinity;
  private tMax = -Infinity;
  private eMin = Infinity;
  private eMax = -Infinity;

  push(frame: AnalysisFrame): void {
    const t = frame.time;
    if (!Number.isFinite(t)) return;

    this.srcCount++;

    const tempHi = frame.temperatureMax ?? frame.temperature;
    if (frame.temperature < this.tMin) this.tMin = frame.temperature;
    if (tempHi > this.tMax) this.tMax = tempHi;
    const excLo = frame.excursionMin ?? frame.excursion;
    const excHi = frame.excursionMax ?? frame.excursion;
    if (excLo < this.eMin) this.eMin = excLo;
    if (excHi > this.eMax) this.eMax = excHi;

    if (this.count > 0 && this.bucketSec > 0 && t < this.bucketStart + this.bucketSec) {
      this.mergeInto(this.count - 1, frame.temperature, frame.excursion);
      this.dirty = true;
      return;
    }

    if (this.count > 0) {
      const d = t - this.xs[this.count - 1];
      if (d > 0 && d < this.minDelta) this.minDelta = d;
    }

    this.xs[this.count] = t;
    this.temps[this.count] = frame.temperature;
    this.excs[this.count] = frame.excursion;
    this.bucketStart = t;
    this.count++;

    if (this.count >= MAX_CHART_POINTS) this.compact();
    this.dirty = true;
  }

  reset(): void {
    this.count = 0;
    this.bucketSec = 0;
    this.bucketStart = 0;
    this.minDelta = Infinity;
    this.srcCount = 0;
    this.tMin = Infinity;
    this.tMax = -Infinity;
    this.eMin = Infinity;
    this.eMax = -Infinity;
    this.dirty = false;
    this.invalidate();
  }

  seed(frames: AnalysisFrame[]): void {
    this.reset();
    for (const f of frames) this.push(f);
    this.dirty = true;
    this.flush();
  }

  protected buildSnapshot(): ChartSnapshot {
    const last = this.count - 1;
    return {
      version: this.ver,
      count: this.count,
      lastTemperature: last >= 0 ? this.temps[last] : null,
      lastExcursion: last >= 0 ? this.excs[last] : null,
      tempMin: this.tMin,
      tempMax: this.tMax,
      excMin: this.eMin,
      excMax: this.eMax,
      sourceCount: this.srcCount,
      pointInterval: this.bucketSec > 0
        ? this.bucketSec
        : (Number.isFinite(this.minDelta) ? this.minDelta : 0),
      firstX: this.count > 0 ? this.xs[0] : null,
      lastX: last >= 0 ? this.xs[last] : null,
    };
  }

  readRange(
    metric: ChartMetric,
    minSec: number,
    maxSec: number,
    maxPoints: number,
    out: SeriesReadBuffer,
    transform?: (v: number) => number,
  ): number {
    const n = this.count;
    if (n === 0) return 0;

    const capacity = Math.min(out.xs.length, out.ys.length);
    if (capacity < 2) return 0;
    const budget = Math.min(maxPoints, capacity);
    if (budget < 2) return 0;

    const xs = this.xs;
    const src = metric === "temperature" ? this.temps : this.excs;

    let i0 = Number.isFinite(minSec) ? lowerBound(xs, n, minSec) : 0;
    let i1 = (Number.isFinite(maxSec) ? upperBound(xs, n, maxSec) : n) - 1;
    if (i0 > 0) i0--;
    i1 = i1 < n - 1 ? Math.min(n - 1, i1 + 2) : n - 1;
    if (i1 < i0) return 0;

    let w = 0;
    const push = (i: number): void => {
      out.xs[w] = xs[i];
      out.ys[w] = transform ? transform(src[i]) : src[i];
      w++;
    };

    const visible = i1 - i0 + 1;
    if (visible <= budget) {
      for (let i = i0; i <= i1 && w < capacity; i++) push(i);
      return w;
    }

    const columns = Math.max(1, (budget - 2) >> 1);
    let lastIdx = -1;
    for (let c = 0; c < columns && w + 2 <= capacity; c++) {
      const s = i0 + Math.floor((c * visible) / columns);
      let e = i0 + Math.floor(((c + 1) * visible) / columns);
      if (e <= s) e = s + 1;
      if (e > i1 + 1) e = i1 + 1;

      let iMin = s;
      let iMax = s;
      for (let i = s + 1; i < e; i++) {
        if (src[i] < src[iMin]) iMin = i;
        if (src[i] > src[iMax]) iMax = i;
      }
      const a = iMin < iMax ? iMin : iMax;
      const b = iMin < iMax ? iMax : iMin;

      if (c === 0 && s !== a) push(s);
      if (a !== lastIdx) push(a);
      if (b !== a) push(b);
      lastIdx = b;
    }
    if (lastIdx !== i1 && w < capacity) push(i1);
    return w;
  }

  valueAt(metric: ChartMetric, timeSec: number): number | null {
    const n = this.count;
    if (n === 0 || !Number.isFinite(timeSec)) return null;
    const xs = this.xs;
    const src = metric === "temperature" ? this.temps : this.excs;
    const i = lowerBound(xs, n, timeSec);
    if (i <= 0) return src[0];
    if (i >= n) return src[n - 1];
    return timeSec - xs[i - 1] <= xs[i] - timeSec ? src[i - 1] : src[i];
  }

  toFrames(): AnalysisFrame[] {
    const out: AnalysisFrame[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      out[i] = { time: this.xs[i], temperature: this.temps[i], excursion: this.excs[i] };
    }
    return out;
  }

  private mergeInto(i: number, temperature: number, excursion: number): void {
    this.temps[i] = temperature;
    if (Math.abs(excursion) > Math.abs(this.excs[i])) this.excs[i] = excursion;
  }

  private compact(): void {
    const src = this.count;
    let w = 0;
    for (let r = 0; r < src; r += 2, w++) {
      const b = r + 1;
      this.xs[w] = this.xs[r];
      if (b < src) {
        this.temps[w] = this.temps[b];
        this.excs[w] = Math.abs(this.excs[r]) >= Math.abs(this.excs[b]) ? this.excs[r] : this.excs[b];
      } else {
        this.temps[w] = this.temps[r];
        this.excs[w] = this.excs[r];
      }
    }
    this.count = w;

    const avg = w > 1 ? (this.xs[w - 1] - this.xs[0]) / (w - 1) : 0;
    let next = Math.max(this.bucketSec * 2, avg);
    if (!Number.isFinite(next) || next <= 0) {
      next = Number.isFinite(this.minDelta) && this.minDelta > 0 ? this.minDelta * 2 : 1e-3;
    }
    this.bucketSec = next;
    this.bucketStart = w > 0 ? this.xs[w - 1] : 0;
    this.minDelta = next;
  }
}
