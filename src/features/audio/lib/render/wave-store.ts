import type { SeriesReadBuffer } from "./read-buffer";

/**
 * 채널 파형 하나의 표시 데이터를 React 상태 밖에서 들고 있는 스토어 —
 * 메인 차트의 ChartStore와 같은 전략을 오디오 파형(min/max 엔벨로프)에 적용한 것이다.
 *
 * 1. **표시 버킷 개수 상한** — 세션이 길어져도 버킷은 MAX_WAVE_BUCKETS를 넘지 않는다. 가득
 *    차면 인접한 두 버킷을 하나로 합치고(compact) 버킷 폭을 두 배로 늘린다. 샘플당 비용은
 *    상각 O(1)이고, 화면에는 언제나 **세션 처음부터 지금까지의 전체 추이**가 담긴다.
 *    예전 채널 뷰는 최근 30초 원본 샘플만 슬라이딩 윈도우로 들고 있어서, 세션이 길어지면
 *    x축 대부분이 빈 채로 파형이 오른쪽 끝에 몰려 보였다.
 * 2. **React 커밋 제거** — 캡처 청크가 도착해도 setState를 하지 않는다. 구독자(차트)가 직접
 *    uPlot에 밀어 넣으므로 상세 뷰 트리 전체가 초당 100번씩 리렌더되지 않는다.
 * 3. **읽기는 뷰포트 단위** — readRange()는 지금 화면에 보이는 x 구간만, 화면 폭으로 묶인
 *    점 수만큼만 낸다. 버킷이 만석(5만 개)이어도 프레임당 처리량이 세션 길이를 따라
 *    늘어나지 않는다. 예전 readAligned()는 호출마다 세션 전체 버킷을 새 배열 두 개로
 *    복사해 냈다(만석 기준 호출당 1.6 MB) — 화면 폭이 1,000 px 남짓인데 10만 점을 매
 *    프레임 훑던 것이 파형 렌더의 주 병목이었다.
 *
 * 버킷은 min/max 한 쌍을 보존하므로(단순 다운샘플링이 아니다) 아무리 압축돼도 파형의
 * 진폭 포락선은 깎이지 않는다. readRange()의 픽셀 열 재결합도 극값의 합집합이라 마찬가지다.
 */

/** 채널 파형 하나가 화면에 유지하는 최대 버킷 수. 버킷당 min/max 2점 = 최대 100000점. */
const MAX_WAVE_BUCKETS = 50000;

/**
 * 압축 전 초기 버킷 폭(초). 48 kHz 기준 버킷당 240 샘플이고, 첫 압축은
 * MAX_WAVE_BUCKETS × 이 값 = 250초 지점에서 일어난다.
 */
const INITIAL_BUCKET_SEC = 0.005;

/**
 * 구간 시작 직전의 "마지막으로 값이 들어온 버킷"을 찾을 때 되짚어볼 최대 버킷 수.
 * 정상 스트림에서는 버킷이 0부터 빈틈없이 차므로 첫 번째 시도에서 곧바로 찾는다 — 이
 * 상한은 비정상적으로 성긴 데이터에서 읽기 비용이 세션 길이를 타지 않게 하는 안전장치다.
 */
const SEED_SCAN_LIMIT = 256;


export interface WaveSnapshot {
  version: number;
  /** 현재 채워진 버킷 수 — 0이면 그릴 게 없다. */
  bucketCount: number;
  /** 지금까지 들어온 마지막 샘플의 시각(초) = x축 전체 도메인의 오른쪽 끝. */
  durationSec: number;
  /** 버킷 하나가 대표하는 시간 폭(초) — 시간축 소수점 자리수 결정용. */
  bucketSec: number;
  /**
   * 세션 누적 절대 피크. 버킷이 합쳐져도 y축이 실제 피크를 잘라먹지 않도록 압축과 무관하게
   * 원본 샘플 전부를 기준으로 유지한다.
   */
  peak: number;
  /** 세션 누적 RMS — 최근 구간이 아니라 캡처 시작부터의 값이다. */
  rms: number;
  /** 누적 샘플 수(압축 전 원본 기준). */
  sampleCount: number;
}

const EMPTY_SNAPSHOT: WaveSnapshot = {
  version: 0,
  bucketCount: 0,
  durationSec: 0,
  bucketSec: INITIAL_BUCKET_SEC,
  peak: 0,
  rms: 0,
  sampleCount: 0,
};

export class ChannelWaveStore {
  private mins = new Float64Array(MAX_WAVE_BUCKETS);
  private maxs = new Float64Array(MAX_WAVE_BUCKETS);
  private seen = new Uint8Array(MAX_WAVE_BUCKETS);
  private count = 0;

  /** 압축 전 초기 버킷 폭(초). 생성자로 넘기지 않으면 기존 기본값(5ms)을 쓴다. */
  private readonly initialBucketSec: number;
  private bucketSec: number;
  private durationSec = 0;

  constructor(initialBucketSec: number = INITIAL_BUCKET_SEC) {
    this.initialBucketSec = initialBucketSec;
    this.bucketSec = initialBucketSec;
  }

  private peakAbs = 0;
  private sumSq = 0;
  private sampleCount = 0;

  private ver = 0;
  private dirty = false;
  private listeners = new Set<() => void>();
  private cachedSnapshot: WaveSnapshot = EMPTY_SNAPSHOT;

  /**
   * 갱신 알림 구독. 인스턴스에 바인딩된 안정된 참조라 이펙트 의존성에 그대로 넣어도
   * 재구독이 일어나지 않는다. 알림은 flush() 시점에만 발생하고, 실제 그리기 빈도는
   * 구독자(UPlotChart의 source 경로)가 rAF로 정한다.
   */
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  /**
   * 연속된 샘플 블록 하나를 시간 위치 그대로 반영한다. 알림은 발생하지 않는다 —
   * 배치 후 flush()를 호출한다.
   *
   * 버킷을 절대 시각으로 찾으므로 호출 순서에 의존하지 않는다 — 라이브 청크(현재 시각)와
   * 세션 초반 백필(과거 구간)이 섞여 들어와도 각자 제자리에 쌓인다.
   *
   * ⚠️ `data`는 이 호출이 끝나면 더 이상 참조하지 않는다(값을 즉시 버킷으로 소화한다) —
   * 호출부가 프레임마다 새 배열을 만들지 않고 scratch 버퍼 하나를 재사용해도 안전하다.
   */
  addBlock(data: Float32Array, startSec: number, sampleRate: number): void {
    const n = data.length;
    if (n === 0 || !(sampleRate > 0) || !Number.isFinite(startSec)) return;

    const step = 1 / sampleRate;
    const endSec = startSec + (n - 1) * step;
    // 블록 전체가 들어갈 때까지 미리 압축해 둔다 — 루프 안에서 버킷 폭이 바뀌지 않게.
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

  /** 마지막 flush 이후 반영된 게 있으면 버전을 올리고 구독자에게 알린다. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.ver++;
    this.cachedSnapshot = EMPTY_SNAPSHOT; // 다음 snapshot() 호출 때 다시 만든다
    this.listeners.forEach((fn) => fn());
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
    this.ver++;
    this.cachedSnapshot = EMPTY_SNAPSHOT;
    this.listeners.forEach((fn) => fn());
  }

  snapshot(): WaveSnapshot {
    if (this.cachedSnapshot.version === this.ver && this.ver !== 0) return this.cachedSnapshot;
    this.cachedSnapshot = {
      version: this.ver,
      bucketCount: this.count,
      durationSec: this.durationSec,
      bucketSec: this.bucketSec,
      peak: this.peakAbs,
      rms: this.sampleCount > 0 ? Math.sqrt(this.sumSq / this.sampleCount) : 0,
      sampleCount: this.sampleCount,
    };
    return this.cachedSnapshot;
  }

  /**
   * [minSec, maxSec] 구간을 최대 maxPoints개 (x, y) 점으로 `out`에 채우고 **채운 개수**를
   * 돌려준다. 호출자는 out.xs/ys의 앞 count개만 유효한 것으로 읽는다.
   *
   * - 가시 버킷 수 × 2 ≤ 예산 → 버킷을 그대로 min/max 2점씩 낸다(x는 버킷 시작, 그리고
   *   버킷 중앙). 선이 위아래로 오가며 진폭 포락선을 그리는 envelope.ts와 같은 표현이다.
   * - 예산을 넘으면 → 픽셀 열 하나에 여러 버킷을 몰아 min/max **합집합**으로 재결합한다.
   *   극값을 합치는 것이라 화면에 나타나는 진폭은 줄지 않는다.
   *
   * 구간 밖 버킷은 아예 순회하지 않고(시작/끝 인덱스를 나눗셈 한 번으로 구한다), 낸 점
   * 수는 예산으로 묶이므로 비용이 세션 길이를 따라 늘지 않는다.
   */
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

    // 구간 시작 직전에 마지막으로 값이 들어온 버킷을 seed로 잡는다 — 빈 버킷을 직전 값으로
    // 잇는 규칙이 구간 경계에서 0으로 뚝 떨어지지 않게 하기 위함이다.
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
        // 이 열에 값이 하나도 없다(정상 스트림에서는 생기지 않는다) — 직전 값을 유지해
        // 선이 0으로 튀지 않게 한다.
        mn = lastMin;
        mx = lastMax;
      } else {
        lastMin = mn;
        lastMax = mx;
      }

      const t = cs * bucketSec;
      // 열의 중앙. 마지막 열은 대개 절반만 찬 상태라 x축 도메인([0, durationSec]) 밖으로
      // 삐져나갈 수 있어 끝에 맞춰 잘라 준다. 마지막이 아닌 열의 중앙은 언제나 다음 열의
      // 시작보다 앞이므로(중앙 < ce × bucketSec ≤ durationSec) 이 보정이 x 순서를 깨지 않는다.
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

  /**
   * 주어진 시각(초)이 속한 버킷의 대표값(min/max 중점)을 돌려준다. 없으면 null.
   * 커서 툴팁처럼 "지금 이 시각의 값 하나"가 필요한 저빈도 조회용 — readRange()처럼
   * 매 프레임 쓰는 경로가 아니라 버퍼 없이 즉시 계산한다.
   */
  valueAt(timeSec: number): number | null {
    if (!(timeSec >= 0) || this.count === 0) return null;
    const b = Math.floor(timeSec / this.bucketSec);
    if (b < 0 || b >= this.count || this.seen[b] === 0) return null;
    return (this.mins[b] + this.maxs[b]) / 2;
  }

  /** 주어진 시각이 버킷 상한 안에 들어올 때까지 압축한다. */
  private ensureCapacity(maxTimeSec: number): void {
    if (!(maxTimeSec > 0)) return;
    let guard = 0;
    while (Math.floor(maxTimeSec / this.bucketSec) >= MAX_WAVE_BUCKETS && guard++ < 64) {
      this.compact();
    }
  }

  /** 버킷 개수를 절반으로 줄이고 폭을 두 배로 넓힌다 — min/max는 두 버킷의 합집합 극값. */
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
