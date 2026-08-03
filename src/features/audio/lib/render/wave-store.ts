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
 *
 * 버킷은 min/max 한 쌍을 보존하므로(단순 다운샘플링이 아니다) 아무리 압축돼도 파형의
 * 진폭 포락선은 깎이지 않는다. ChannelWaveformCanvas는 확대 시에도 원본 해상도 데이터를
 * 다시 가져오지 않고 이 스토어의 세션 전체 min/max 엔벨로프를 readAligned()로 읽는다.
 */

/** 채널 파형 하나가 화면에 유지하는 최대 버킷 수. 버킷당 min/max 2점 = 최대 2000점. */
const MAX_WAVE_BUCKETS = 1000;

/**
 * 압축 전 초기 버킷 폭(초). 48 kHz 기준 버킷당 240 샘플이고, 첫 압축은
 * MAX_WAVE_BUCKETS × 이 값 = 5초 지점에서 일어난다.
 */
const INITIAL_BUCKET_SEC = 0.005;

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

  private bucketSec = INITIAL_BUCKET_SEC;
  private durationSec = 0;

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
    this.bucketSec = INITIAL_BUCKET_SEC;
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
   * uPlot에 그대로 넘길 [x, y] 컬럼. 버킷당 2점(min이 t, max가 t+폭/2)이라 선이 위아래로
   * 오가며 진폭 포락선을 그린다 — envelope.ts의 격자와 같은 표현이다.
   *
   * 내부 버퍼의 뷰가 아니라 **복사본**을 돌려준다 — 뷰를 넘기면 다음 addBlock/compact가
   * uPlot이 들고 있는 배열을 그 자리에서 바꿔버려 커서 이동 같은 자체 리드로우가 반쯤
   * 갱신된 데이터를 그리게 된다. 길이가 상한(MAX_WAVE_BUCKETS×2)으로 묶여 있어 복사
   * 비용은 세션 길이와 무관하게 일정하다.
   */
  readAligned(): [Float64Array, Float64Array] {
    const n = this.count;
    const xs = new Float64Array(n * 2);
    const ys = new Float64Array(n * 2);
    const bucketSec = this.bucketSec;
    const half = bucketSec * 0.5;
    // 빈 버킷(정상 스트림에서는 생기지 않는다)은 직전 값을 유지해 선이 0으로 튀지 않게 한다.
    let lastMin = 0;
    let lastMax = 0;
    for (let b = 0; b < n; b++) {
      const t = b * bucketSec;
      if (this.seen[b] === 1) {
        lastMin = this.mins[b];
        lastMax = this.maxs[b];
      }
      xs[b * 2] = t;
      // 마지막 버킷은 대개 절반만 찬 상태라 t+폭/2가 실제 세션 끝을 넘어설 수 있다 —
      // 넘어가면 x축 도메인([0, durationSec]) 밖으로 삐져나가므로 끝에 맞춰 잘라 준다.
      // (버킷이 존재한다는 건 t 시각의 샘플이 들어왔다는 뜻이므로 t < durationSec은 보장된다.)
      const half2 = t + half;
      xs[b * 2 + 1] = half2 > this.durationSec ? this.durationSec : half2;
      ys[b * 2] = lastMin;
      ys[b * 2 + 1] = lastMax;
    }
    return [xs, ys];
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
