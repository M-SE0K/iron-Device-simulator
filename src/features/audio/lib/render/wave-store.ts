import { aggregateEnvelope, type PcmSource } from "@/features/audio/lib/pcm-kit";
import { INT16_SCALE } from "@/features/audio/lib/engine/core";
import { getEnvelopeMode } from "@/shared/lib/iron-perf";
import { MAX_READ_COLUMNS, type SeriesReadBuffer } from "./read-buffer";
import { VersionedSnapshotStore } from "./store-base";

export const MAX_WAVE_BUCKETS = 50000;

const INITIAL_BUCKET_SEC = 0.005;

const SEED_SCAN_LIMIT = 256;

/** 컬럼 c 가 덮는 버킷 구간 [cs, ce). readRange(그리기)와 pointAt(툴팁)이 같은 격자를
 *  쓰도록 한 곳에 둔다 — 어긋나면 툴팁이 화면과 다른 점을 가리킨다. */
export function columnBounds(b0: number, b1: number, columns: number, c: number): [number, number] {
  const visible = b1 - b0;
  const cs = b0 + Math.floor((c * visible) / columns);
  let ce = b0 + Math.floor(((c + 1) * visible) / columns);
  if (ce <= cs) ce = cs + 1;
  if (ce > b1) ce = b1;
  return [cs, ce];
}

/* 레거시(A/B 측정) 경로 전용 — 옛 구현의 EXTRACT_CHUNK_FRAMES 와 동일한 청크 크기. */
const LEGACY_EXTRACT_CHUNK_FRAMES = 131072;
let legacyScratch: Float32Array | null = null;


export interface AddSamplesOpts {
  channels: number;
  channel: number;
  frames: number;
  startSec: number;
  sampleRate: number;
}

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

  /** 인터리브 원본(int16/float32)에서 한 채널을 골라 직접 집계한다 — 사전 채널
   * 추출 pass 없이 pcm-kit 커널(WASM, 미로드 시 JS 폴백)로 벌크 처리하는 주 경로. */
  addSamples(src: PcmSource, opts: AddSamplesOpts): void {
    const { channels, channel, frames, startSec, sampleRate } = opts;
    if (frames <= 0 || !(sampleRate > 0) || !Number.isFinite(startSec) || startSec < 0) return;

    if (getEnvelopeMode() === "legacy") {
      this.addSamplesLegacy(src, opts);
      return;
    }

    const step = 1 / sampleRate;
    const endSec = startSec + (frames - 1) * step;
    this.ensureCapacity(endSec);

    const stats = aggregateEnvelope(
      src, channels, channel, frames, startSec, sampleRate, this.bucketSec, MAX_WAVE_BUCKETS,
      (firstBucket, count, mins, maxs) => this.mergeBuckets(firstBucket, count, mins, maxs),
    );

    if (stats.peak > this.peakAbs) this.peakAbs = stats.peak;
    this.sumSq += stats.sumSq;
    this.sampleCount += frames;
    if (endSec + step > this.durationSec) this.durationSec = endSec + step;
    this.dirty = true;
  }

  addBlock(data: Float32Array, startSec: number, sampleRate: number): void {
    this.addSamples(data, { channels: 1, channel: 0, frames: data.length, startSec, sampleRate });
  }

  /* ── A/B 측정용 레거시 경로 (__ironPerf.envelopeMode("legacy") 전용) ────────
   * pcm-kit 도입 전 구현을 그대로 보존한 것: 사전 채널 추출 pass(readChannelFloat32
   * 상당) + per-sample floor 버킷팅 2-pass 비용을 재현한다. 측정 빌드가 아니면
   * getEnvelopeMode()가 항상 "wasm"이라 도달하지 않는다. 비교가 끝나면 삭제 가능. */
  private addSamplesLegacy(src: PcmSource, opts: AddSamplesOpts): void {
    const { channels, channel, frames, startSec, sampleRate } = opts;
    for (let off = 0; off < frames; off += LEGACY_EXTRACT_CHUNK_FRAMES) {
      const n = Math.min(LEGACY_EXTRACT_CHUNK_FRAMES, frames - off);
      let data: Float32Array;
      if (channels === 1 && src instanceof Float32Array) {
        data = src.subarray(off, off + n);
      } else {
        const scratch = (legacyScratch ??= new Float32Array(LEGACY_EXTRACT_CHUNK_FRAMES));
        const scale = src instanceof Int16Array ? 1 / INT16_SCALE : 1;
        for (let i = 0; i < n; i++) scratch[i] = src[(off + i) * channels + channel] * scale;
        data = scratch.subarray(0, n);
      }
      this.legacyBlock(data, startSec + off / sampleRate, sampleRate);
    }
  }

  /* pcm-kit 도입 전 addBlock 본문 그대로 (per-sample floor 버킷팅). */
  private legacyBlock(data: Float32Array, startSec: number, sampleRate: number): void {
    const n = data.length;
    if (n === 0) return;

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

  private mergeBuckets(firstBucket: number, count: number, mins: Float32Array, maxs: Float32Array): void {
    for (let j = 0; j < count; j++) {
      const mn = mins[j];
      const mx = maxs[j];
      if (mn > mx) continue;                       // 빈 버킷 센티널
      const b = firstBucket + j;
      if (b < 0 || b >= MAX_WAVE_BUCKETS) continue;
      if (this.seen[b] === 0) {
        this.mins[b] = mn;
        this.maxs[b] = mx;
        this.seen[b] = 1;
        if (b >= this.count) this.count = b + 1;
      } else {
        if (mn < this.mins[b]) this.mins[b] = mn;
        if (mx > this.maxs[b]) this.maxs[b] = mx;
      }
    }
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
      const [cs, ce] = columnBounds(b0, b1, columns, c);

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

  /* 같은 (minSec, maxSec, columns) 로 readRange 를 부를 때 캔버스에 실제로 찍히는 꼭짓점
   * 중, timeSec 에 x 가 가장 가까운 것. 툴팁이 "화면 위의 그 점"을 그대로 읽게 하려고
   * 컬럼 경계 산식(columnBounds, 빈 컬럼 홀드, 꼭짓점 x 위치)을 readRange 와 공유한다.
   * readRange 는 컬럼마다 (컬럼 시작, min) 과 (컬럼 중앙, max) 두 점을 찍는다. */
  pointAt(minSec: number, maxSec: number, columns: number, timeSec: number): { timeSec: number; value: number } | null {
    const n = this.count;
    if (n === 0) return null;
    if (!Number.isFinite(minSec) || !Number.isFinite(maxSec) || !Number.isFinite(timeSec)) return null;

    const bucketSec = this.bucketSec;
    let b0 = Math.floor(minSec / bucketSec);
    let b1 = Math.ceil(maxSec / bucketSec) + 1;
    if (b0 < 0) b0 = 0;
    if (b1 > n) b1 = n;
    if (b1 <= b0) return null;

    const visible = b1 - b0;
    const cols = Math.min(visible, Math.max(1, Math.floor(columns)), MAX_READ_COLUMNS);

    let b = Math.floor(timeSec / bucketSec);
    if (b < b0) b = b0;
    if (b >= b1) b = b1 - 1;

    /* cs(c) = b0 + floor(c*visible/cols) 분할의 역함수: b 를 담는 컬럼은
     * floor(c*visible/cols) <= b-b0 을 만족하는 최대 c = ceil((b-b0+1)*cols/visible) - 1.
     * 나눗셈 반올림으로 한 칸 어긋날 수 있어 정방향 식으로 되돌려 보정한다(최대 1회). */
    let c = Math.ceil(((b - b0 + 1) * cols) / visible) - 1;
    if (c < 0) c = 0;
    if (c >= cols) c = cols - 1;
    while (c > 0 && columnBounds(b0, b1, cols, c)[0] > b) c--;
    while (c + 1 < cols && columnBounds(b0, b1, cols, c + 1)[0] <= b) c++;

    /* 가장 가까운 꼭짓점은 이웃 컬럼에 있을 수 있다(커서가 컬럼 경계 근처인 경우). */
    let best: { timeSec: number; value: number } | null = null;
    let bestDist = Infinity;
    const consider = (x: number, value: number): void => {
      const d = x > timeSec ? x - timeSec : timeSec - x;
      if (d < bestDist) {
        bestDist = d;
        best = { timeSec: x, value };
      }
    };

    for (let k = c - 1; k <= c + 1; k++) {
      if (k < 0 || k >= cols) continue;
      const [cs, ce] = columnBounds(b0, b1, cols, k);
      const band = this.columnBand(cs, ce);
      const t0 = cs * bucketSec;
      const mid = t0 + (ce - cs) * bucketSec * 0.5;
      consider(t0, band.min);
      consider(mid > this.durationSec ? this.durationSec : mid, band.max);
    }
    return best;
  }

  /* readRange 의 컬럼 집계와 동일 — 빈 컬럼은 직전 버킷을 홀드하고, 그마저 없으면 0
   * (readRange 의 lastMin/lastMax 초기값). */
  private columnBand(cs: number, ce: number): { min: number; max: number } {
    let mn = Infinity;
    let mx = -Infinity;
    for (let b = cs; b < ce; b++) {
      if (this.seen[b] === 0) continue;
      if (this.mins[b] < mn) mn = this.mins[b];
      if (this.maxs[b] > mx) mx = this.maxs[b];
    }
    if (mn <= mx) return { min: mn, max: mx };

    for (let b = cs - 1, scanned = 0; b >= 0 && scanned < SEED_SCAN_LIMIT; b--, scanned++) {
      if (this.seen[b] === 1) return { min: this.mins[b], max: this.maxs[b] };
    }
    return { min: 0, max: 0 };
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
