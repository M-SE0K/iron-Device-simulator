import type { AnalysisFrame, SpeakerFault } from "@/features/audio/types";
import { detectSpeakerFault } from "@/features/audio/lib/engine/core";
import type { SeriesReadBuffer } from "./read-buffer";
import { VersionedSnapshotStore } from "./store-base";

const MAX_CHART_POINTS = 30000;

export type ChartMetric = "temperature" | "excursion";

/* faults 열의 인코딩 — Uint8Array 한 칸으로 "이 포인트를 온도 계열에서 빼라"를 표시한다. */
const FAULT_NONE = 0;
const FAULT_OPEN = 1;
const FAULT_SHORT = 2;

const faultCode = (fault: SpeakerFault | null): number =>
  fault === "open" ? FAULT_OPEN : fault === "short" ? FAULT_SHORT : FAULT_NONE;

const faultOf = (code: number): SpeakerFault | null =>
  code === FAULT_OPEN ? "open" : code === FAULT_SHORT ? "short" : null;

export interface ChartSnapshot {
  version: number;
  count: number;
  /** 마지막 포인트의 온도 — 그 포인트가 온도 가드에 걸렸으면 null 이다(표기 제거). */
  lastTemperature: number | null;
  lastExcursion: number | null;
  /** 마지막 포인트의 스피커 이상 상태. 정상으로 돌아오면 곧바로 null 이 된다. */
  lastSpeakerFault: SpeakerFault | null;
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
  /* 온도 가드에 걸린 포인트 표시. 값 자체는 이미 0 이라 값만으로는 구분할 수 없어서
   * 별도 열로 든다 — 온도 계열의 y 범위·리드아웃·렌더 모두 이 열을 보고 해당 포인트를
   * 통째로 건너뛴다(0 을 그리지 않는다 = 요구사항 "온도 표기 없앨 것"). */
  private faults = new Uint8Array(MAX_CHART_POINTS);
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

    /* 가드 범위를 벗어난 프레임은 온도/변위를 0 으로 눕히고 fault 로 표시한다. 엔진
     * (wasm-client)이 이미 같은 판정을 실어 보내지만, 세션 캐시 복원처럼 엔진을 거치지 않고
     * 들어오는 프레임도 있어서 플래그가 없으면 값으로 한 번 더 판정한다(캐시된 값은 이미
     * 0 이라 이 경로에서는 플래그가 유일한 근거다 — frame-utils 가 함께 저장한다). */
    const fault = frame.speakerFault
      ?? detectSpeakerFault(Math.max(frame.temperature, frame.temperatureMax ?? frame.temperature));
    const temperature = fault ? 0 : frame.temperature;
    const excursion = fault ? 0 : frame.excursion;

    /* 온도 y 범위는 fault 포인트를 빼고 잡는다 — 그리지 않을 0 때문에 축이 늘어나면
     * 정상 구간이 납작해진다. 변위는 기존 동작(0 포함)을 유지한다. */
    if (!fault) {
      const tempHi = frame.temperatureMax ?? frame.temperature;
      if (temperature < this.tMin) this.tMin = temperature;
      if (tempHi > this.tMax) this.tMax = tempHi;
    }
    const excLo = fault ? 0 : (frame.excursionMin ?? frame.excursion);
    const excHi = fault ? 0 : (frame.excursionMax ?? frame.excursion);
    if (excLo < this.eMin) this.eMin = excLo;
    if (excHi > this.eMax) this.eMax = excHi;

    if (this.count > 0 && this.bucketSec > 0 && t < this.bucketStart + this.bucketSec) {
      this.mergeInto(this.count - 1, temperature, excursion, fault);
      this.dirty = true;
      return;
    }

    if (this.count > 0) {
      const d = t - this.xs[this.count - 1];
      if (d > 0 && d < this.minDelta) this.minDelta = d;
    }

    this.xs[this.count] = t;
    this.temps[this.count] = temperature;
    this.excs[this.count] = excursion;
    this.faults[this.count] = faultCode(fault);
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
    const lastFault = last >= 0 ? faultOf(this.faults[last]) : null;
    return {
      version: this.ver,
      count: this.count,
      /* fault 포인트에서는 온도 수치를 아예 내보내지 않는다 — 리드아웃(MetricChartCard)이
       * null 을 받으면 값 자체를 렌더하지 않는다. */
      lastTemperature: last >= 0 && lastFault === null ? this.temps[last] : null,
      lastExcursion: last >= 0 ? this.excs[last] : null,
      lastSpeakerFault: lastFault,
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
    /* 온도 계열에서는 fault 포인트를 아예 내보내지 않는다 — 0 을 그리는 대신 그 구간의
     * 포인트가 없어진다(uPlot 은 앞뒤 포인트를 직선으로 잇는다). 변위 계열은 그대로 둔다. */
    const faults = metric === "temperature" ? this.faults : null;
    const skipped = (i: number): boolean => faults !== null && faults[i] !== FAULT_NONE;

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
      for (let i = i0; i <= i1 && w < capacity; i++) {
        if (!skipped(i)) push(i);
      }
      return w;
    }

    const columns = Math.max(1, (budget - 2) >> 1);
    let lastIdx = -1;
    for (let c = 0; c < columns && w + 2 <= capacity; c++) {
      const s = i0 + Math.floor((c * visible) / columns);
      let e = i0 + Math.floor(((c + 1) * visible) / columns);
      if (e <= s) e = s + 1;
      if (e > i1 + 1) e = i1 + 1;

      let iMin = -1;
      let iMax = -1;
      for (let i = s; i < e; i++) {
        if (skipped(i)) continue;
        if (iMin < 0 || src[i] < src[iMin]) iMin = i;
        if (iMax < 0 || src[i] > src[iMax]) iMax = i;
      }
      if (iMin < 0) continue; // 컬럼 전체가 fault — 이 구간은 포인트 없이 비운다
      const a = iMin < iMax ? iMin : iMax;
      const b = iMin < iMax ? iMax : iMin;

      if (c === 0 && s !== a && !skipped(s)) push(s);
      if (a !== lastIdx) push(a);
      if (b !== a) push(b);
      lastIdx = b;
    }
    if (lastIdx !== i1 && w < capacity && !skipped(i1)) push(i1);
    return w;
  }

  valueAt(metric: ChartMetric, timeSec: number): number | null {
    const n = this.count;
    if (n === 0 || !Number.isFinite(timeSec)) return null;
    const xs = this.xs;
    const src = metric === "temperature" ? this.temps : this.excs;
    /* 온도는 fault 구간에서 값이 "없는" 것으로 취급한다 — 렌더에서 뺀 0 을 조회 경로로
     * 되돌려 보여주면 표기를 없앤 의미가 사라진다. */
    const blanked = (i: number): boolean => metric === "temperature" && this.faults[i] !== FAULT_NONE;
    const i = lowerBound(xs, n, timeSec);
    if (i <= 0) return blanked(0) ? null : src[0];
    if (i >= n) return blanked(n - 1) ? null : src[n - 1];
    const nearest = timeSec - xs[i - 1] <= xs[i] - timeSec ? i - 1 : i;
    return blanked(nearest) ? null : src[nearest];
  }

  toFrames(): AnalysisFrame[] {
    const out: AnalysisFrame[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const fault = faultOf(this.faults[i]);
      out[i] = {
        time: this.xs[i],
        temperature: this.temps[i],
        excursion: this.excs[i],
        ...(fault ? { speakerFault: fault } : {}),
      };
    }
    return out;
  }

  /* 같은 버킷에 fault 프레임이 하나라도 섞이면 그 버킷 전체를 fault 로 본다 — 온도가
   * 이미 신뢰할 수 없는 구간이라 대표값을 그리는 쪽이 더 위험하다. */
  private mergeInto(i: number, temperature: number, excursion: number, fault: SpeakerFault | null): void {
    this.temps[i] = temperature;
    if (fault !== null) this.faults[i] = faultCode(fault);
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
        /* 온도를 b 에서 가져오므로 fault 표시도 b 를 따르되, r 이 fault 였다면 그 구간이
         * 통째로 사라지지 않도록 승계한다. */
        this.faults[w] = this.faults[b] !== FAULT_NONE ? this.faults[b] : this.faults[r];
        this.excs[w] = Math.abs(this.excs[r]) >= Math.abs(this.excs[b]) ? this.excs[r] : this.excs[b];
      } else {
        this.temps[w] = this.temps[r];
        this.faults[w] = this.faults[r];
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
