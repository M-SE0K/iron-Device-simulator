import type { AnalysisFrame } from "@/features/audio/types";
import type { SeriesReadBuffer } from "./read-buffer";

/**
 * 메인 차트(Temperature/Excursion)의 표시 데이터를 React 상태 밖에서 들고 있는 스토어.
 *
 * 두 가지를 동시에 해결한다.
 *
 * 1. **표시 점 개수 상한** — 세션이 길어져도 점은 MAX_CHART_POINTS를 넘지 않는다. 가득 차면
 *    인접한 두 점을 하나로 합치고(compact) 버킷 폭을 두 배로 늘린다. 프레임당 비용은 상각
 *    O(1)이고, uPlot이 한 번에 그리는 점 수도 상수로 고정된다. 예전엔 누적 프레임 전체를
 *    매 커밋마다 새 배열로 만들어 통째로 다시 그렸기 때문에 총비용이 세션 길이의 O(n²)였다.
 * 2. **React 커밋 제거** — 프레임이 도착해도 setState를 하지 않는다. 구독자(차트)가 직접
 *    uPlot에 밀어 넣으므로 대시보드 트리 전체가 초당 수십~수백 번 리렌더되지 않는다.
 *
 * 감량은 표시 경로에만 적용된다 — 엔진이 계산한 원본 프레임은 DashboardClient의
 * allFramesRef가 전량 그대로 보존하므로 저장/CSV·JSON export는 영향받지 않는다.
 * (입력 PCM은 어디서도 버리지 않는다.)
 */

/** 차트 하나가 화면에 유지하는 최대 점 개수. */
const MAX_CHART_POINTS = 30000;

export type ChartMetric = "temperature" | "excursion";

/** 스칼라 요약 — 리렌더 비용이 없어야 하는 값들만 담는다(배열 복사 없음). */
export interface ChartSnapshot {
  version: number;
  count: number;
  /** 마지막 점의 값 — 헤더 현재값 표시용. */
  lastTemperature: number | null;
  lastExcursion: number | null;
  /**
   * 누적 극값. 감량으로 점이 합쳐져도 y축이 실제 피크를 잘라먹지 않도록, 합치기 전
   * 원본 프레임 전부를 기준으로 유지한다.
   */
  tempMin: number;
  tempMax: number;
  excMin: number;
  excMax: number;
  /** 감량 전 실제 누적 프레임 수. */
  sourceCount: number;
  /** 현재 점 하나가 대표하는 시간 간격(초). */
  pointInterval: number;
  /**
   * 전체(줌 아웃) x 도메인의 양 끝 — 점이 없으면 null. 뷰포트만 커밋하면 u.data의 extent가
   * "지금 보는 창"이 돼 버려서, 줌 판정과 줌아웃 복원의 기준을 이 값으로 따로 알려줘야 한다.
   */
  firstX: number | null;
  lastX: number | null;
}

const EMPTY_SNAPSHOT: ChartSnapshot = {
  version: 0,
  count: 0,
  lastTemperature: null,
  lastExcursion: null,
  tempMin: Infinity,
  tempMax: -Infinity,
  excMin: Infinity,
  excMax: -Infinity,
  sourceCount: 0,
  pointInterval: 0,
  firstX: null,
  lastX: null,
};

/** arr[0..n) 오름차순에서 value 이상이 처음 나오는 인덱스. */
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

/** arr[0..n) 오름차순에서 value 초과가 처음 나오는 인덱스. */
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

export class ChartStore {
  private xs = new Float64Array(MAX_CHART_POINTS);
  private temps = new Float64Array(MAX_CHART_POINTS);
  private excs = new Float64Array(MAX_CHART_POINTS);
  private count = 0;

  /** 0이면 아직 감량 전(프레임 1개 = 점 1개). 0보다 크면 점 하나가 이 폭의 시간 버킷이다. */
  private bucketSec = 0;
  private bucketStart = 0;
  private minDelta = Infinity;

  private srcCount = 0;
  private tMin = Infinity;
  private tMax = -Infinity;
  private eMin = Infinity;
  private eMax = -Infinity;

  private ver = 0;
  private dirty = false;
  private listeners = new Set<() => void>();
  private cachedSnapshot: ChartSnapshot = EMPTY_SNAPSHOT;

  /**
   * 데이터가 갱신됐을 때 호출될 콜백을 등록한다. 인스턴스에 바인딩된 안정된 참조라
   * 이펙트 의존성에 그대로 넣어도 재구독이 일어나지 않는다.
   *
   * 알림 자체는 flush() 시점에만 발생하고, 실제 그리기 빈도는 구독자가 정한다
   * (차트는 rAF로 합쳐 최대 실제 화면 주사율로 커밋한다).
   */
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  /** 표시 프레임 하나 추가. 알림은 발생하지 않는다 — 배치 후 flush()를 호출한다. */
  push(frame: AnalysisFrame): void {
    const t = frame.time;
    if (!Number.isFinite(t)) return;

    this.srcCount++;

    // 극값은 coalesce가 계산해 둔 버킷 극값(있으면)까지 반영해 누적한다.
    const tempHi = frame.temperatureMax ?? frame.temperature;
    if (frame.temperature < this.tMin) this.tMin = frame.temperature;
    if (tempHi > this.tMax) this.tMax = tempHi;
    const excLo = frame.excursionMin ?? frame.excursion;
    const excHi = frame.excursionMax ?? frame.excursion;
    if (excLo < this.eMin) this.eMin = excLo;
    if (excHi > this.eMax) this.eMax = excHi;

    // 현재 열려 있는 버킷 안이면 새 점을 만들지 않고 마지막 점에 합친다.
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

  /** 마지막 flush 이후 push된 게 있으면 버전을 올리고 구독자에게 알린다. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.ver++;
    this.cachedSnapshot = EMPTY_SNAPSHOT; // 다음 snapshot() 호출 때 다시 만든다
    this.emit();
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
    this.ver++;
    this.cachedSnapshot = EMPTY_SNAPSHOT;
    this.emit();
  }

  /** 캐시 복원용 — 리셋 후 주어진 프레임을 그대로 채워 넣는다. */
  seed(frames: AnalysisFrame[]): void {
    this.reset();
    for (const f of frames) this.push(f);
    this.dirty = true;
    this.flush();
  }

  snapshot(): ChartSnapshot {
    if (this.cachedSnapshot.version === this.ver && this.ver !== 0) return this.cachedSnapshot;
    const last = this.count - 1;
    this.cachedSnapshot = {
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
    return this.cachedSnapshot;
  }

  /**
   * [minSec, maxSec] 구간을 최대 maxPoints개 (x, y) 점으로 `out`에 채우고 채운 개수를 돌려준다.
   *
   * 감량 방식이 파형(ChannelWaveStore.readRange)과 다르다. 파형은 진폭 포락선이라 버킷 시작·중앙에
   * min/max를 합성해 찍어도 되지만, 메트릭 선은 "언제 그 값이었나"가 곧 의미라 **원본 점의 x를
   * 그대로** 쓴다. 픽셀 열마다 최소·최대인 실제 점 두 개를 골라 **원래 순서대로** 내보내므로,
   * 피크가 깎이지 않으면서 선의 진행 방향(상승/하강)도 뒤집히지 않는다. x가 실제 데이터 점의
   * 값이라 툴팁 스냅·점 잇기 주석도 여전히 진짜 측정 시각에 붙는다.
   *
   * 양 끝점을 따로 챙겨 내는 이유는 둘이다 — 선이 화면 경계에서 끊겨 보이지 않게 하고,
   * 마지막 점이 항상 포함돼야 streamFollow의 시계 앵커(마지막 커밋 x)가 실제 최신 프레임과
   * 어긋나지 않는다.
   *
   * ⚠️ `transform`은 단조 증가 함수여야 한다(현재 쓰임은 toMm의 상수배뿐) — 극값은 원본 값으로
   * 찾고 변환은 내보낼 두 점에만 적용하기 때문이다.
   */
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

    // xs는 항상 오름차순이라 가시 인덱스 범위를 이분 탐색으로 O(log n)에 잡는다.
    let i0 = Number.isFinite(minSec) ? lowerBound(xs, n, minSec) : 0;
    let i1 = (Number.isFinite(maxSec) ? upperBound(xs, n, maxSec) : n) - 1;
    // 바깥으로 한 점씩 더 물어 선이 화면 경계에서 끊기지 않게 한다. 오른쪽을 조금 더 넉넉히
    // 잡는 건 스트리밍 때문이다 — 스케일을 읽은 시점과 커밋 시점 사이(한 프레임)에 도착한
    // 최신 점이 잘려 나가면 선 끝이 창 오른쪽 끝에서 뒤처져 보인다.
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

    // 열마다 2점 + 양 끝점 2점.
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

  /** sessionStorage 캐시 저장용 — 감량된 표시 점만 나가므로 크기가 상한에 묶인다. */
  toFrames(): AnalysisFrame[] {
    const out: AnalysisFrame[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      out[i] = { time: this.xs[i], temperature: this.temps[i], excursion: this.excs[i] };
    }
    return out;
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  /**
   * 온도는 마지막 값(느린 RC 적분이라 마지막 값이 곧 그 구간의 대표값), 변위는 절댓값이
   * 큰 쪽을 남긴다 — 변위 차트는 안전 판정용이라 합치는 과정에서 피크가 깎이면 안 된다.
   */
  private mergeInto(i: number, temperature: number, excursion: number): void {
    this.temps[i] = temperature;
    if (Math.abs(excursion) > Math.abs(this.excs[i])) this.excs[i] = excursion;
  }

  /** 점 개수를 절반으로 줄이고 버킷 폭을 그만큼 넓힌다. */
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

    // 새 버킷 폭 = 합쳐진 점들의 평균 간격. 직전 폭의 2배 아래로는 내려가지 않게 잡아
    // 같은 데이터가 반복해서 재압축되는 일이 없게 한다.
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
