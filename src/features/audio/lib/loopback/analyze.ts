import {
  LoopbackCancelledError,
  type BurstDetection,
  type BurstInvalidReason,
  type ChannelResult,
  type LoopbackStats,
} from "./types";

export interface AnalyzeInput {
  /** 캡처 전체(int16 인터리브, 프레임-메이저) — CaptureByteSink.toInt16() 산출물. */
  interleaved: Int16Array;
  channels: number;
  template: Float32Array;
  emissionSamples: number[];
  maxLagSamples: number;
  nccThreshold: number;
  /** ms 환산 전용(헬퍼 actual SR) — 샘플 도메인 결과에는 영향 없음. */
  sampleRateHz: number;
}

export interface AnalyzeResult {
  channels: ChannelResult[];
  bestChannel: number | null;
  stats: LoopbackStats | null;
}

interface AnalyzeOpts {
  isCancelled?: () => boolean;
}

/* (채널×버스트) 창 하나가 최대 maxLag×burstLen ≈ 수백만 곱셈이라, 창 사이마다 이벤트
 * 루프에 양보해 WebView UI가 얼지 않게 한다. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function median(sorted: number[]): number {
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 매치드 필터(정규화 교차상관) 루프백 분석.
 *
 * 채널마다: x를 Float64로 펼치고 프리픽스 에너지(Σx²)를 만든 뒤, 버스트 k의 검색창
 * t ∈ [e_k, e_k+maxLag] 에서 NCC(t) = Σ x[t+i]·tpl[i] / √(Ex(t)·Et) 의 |피크|를 찾는다.
 * |NCC|를 쓰므로 배선 극성이 뒤집혀도, 이득이 달라도 검출된다. 피크 이웃 3점 포물선
 * 보간으로 서브샘플 위치를 구한다(δ ∈ [−0.5, 0.5] 클램프).
 *
 * 무효 판정 — 판정 불가능한 상황은 값을 내지 않고 이유를 남긴다:
 *   capture-short  검색창이 수신 범위 밖으로 잘림(참 피크가 잘린 구간에 있을 수 있음)
 *   window-edge    피크가 창 상단 경계 — 실제 지연이 maxLatencyMs 를 넘는다는 신호
 *   low-correlation 피크 |NCC| < 임계 — 루프백 미배선/무음/잡음
 *
 * 수치 정밀도: 에너지 프리픽스 합은 Float64 누적(총합 ≤ 4M·32767² ≈ 4.3e15 < 2^53 언저리,
 * 정규화 분모로만 쓰여 피크 "위치"에는 영향이 없다). 분자 dot은 창마다 짧은 독립 합이라
 * 오차 축적이 없다.
 */
export async function analyzeLoopbackCapture(input: AnalyzeInput, opts: AnalyzeOpts = {}): Promise<AnalyzeResult> {
  const { interleaved, channels, template, emissionSamples, maxLagSamples, nccThreshold, sampleRateHz } = input;
  const frames = Math.floor(interleaved.length / channels);
  const L = template.length;

  const tpl = new Float64Array(L);
  let templateEnergy = 0;
  for (let i = 0; i < L; i++) {
    tpl[i] = template[i];
    templateEnergy += tpl[i] * tpl[i];
  }

  const channelResults: ChannelResult[] = [];
  const nccByLag = new Float64Array(maxLagSamples + 1);

  for (let ch = 0; ch < channels; ch++) {
    const x = new Float64Array(frames);
    for (let i = 0; i < frames; i++) x[i] = interleaved[i * channels + ch];
    const prefixEnergy = new Float64Array(frames + 1);
    for (let i = 0; i < frames; i++) prefixEnergy[i + 1] = prefixEnergy[i] + x[i] * x[i];

    const detections: BurstDetection[] = [];
    for (let k = 0; k < emissionSamples.length; k++) {
      if (opts.isCancelled?.()) throw new LoopbackCancelledError();
      await yieldToEventLoop();

      const e = emissionSamples[k];
      const fullWindowEnd = e + maxLagSamples;
      const tMax = Math.min(fullWindowEnd, frames - L);
      if (tMax < e || templateEnergy <= 0) {
        detections.push({
          burstIndex: k, emissionSample: e, arrivalSample: null, latencySamples: null,
          latencyMs: null, peakNcc: 0, peakAtWindowEdge: false, valid: false,
          invalidReason: "capture-short",
        });
        continue;
      }
      const windowTruncated = tMax < fullWindowEnd;

      let bestT = e;
      let bestAbs = -1;
      for (let t = e; t <= tMax; t++) {
        let dot = 0;
        for (let i = 0; i < L; i++) dot += x[t + i] * tpl[i];
        const energy = prefixEnergy[t + L] - prefixEnergy[t];
        const abs = energy > 0 ? Math.abs(dot) / Math.sqrt(energy * templateEnergy) : 0;
        nccByLag[t - e] = abs;
        if (abs > bestAbs) {
          bestAbs = abs;
          bestT = t;
        }
      }

      const atLowEdge = bestT === e;
      const atHighEdge = bestT === tMax;
      let delta = 0;
      if (!atLowEdge && !atHighEdge) {
        const y0 = nccByLag[bestT - e - 1];
        const y1 = nccByLag[bestT - e];
        const y2 = nccByLag[bestT - e + 1];
        const denom = y0 - 2 * y1 + y2;
        if (denom < 0) delta = Math.max(-0.5, Math.min(0.5, (y0 - y2) / (2 * denom)));
      }

      let invalidReason: BurstInvalidReason | null = null;
      if (bestAbs < nccThreshold) invalidReason = "low-correlation";
      else if (windowTruncated && atHighEdge) invalidReason = "capture-short";
      else if (atHighEdge) invalidReason = "window-edge";

      const valid = invalidReason === null;
      const arrival = valid ? bestT + delta : null;
      const latencySamples = arrival === null ? null : arrival - e;
      detections.push({
        burstIndex: k,
        emissionSample: e,
        arrivalSample: arrival,
        latencySamples,
        latencyMs: latencySamples === null ? null : (latencySamples / sampleRateHz) * 1000,
        peakNcc: Math.max(0, bestAbs),
        peakAtWindowEdge: atLowEdge || atHighEdge,
        valid,
        invalidReason,
      });
    }

    const validLatencies = detections
      .filter((d) => d.valid && d.latencySamples !== null)
      .map((d) => d.latencySamples as number)
      .sort((a, b) => a - b);
    const nccSum = detections.reduce((acc, d) => acc + d.peakNcc, 0);
    channelResults.push({
      channel: ch,
      detections,
      validCount: validLatencies.length,
      meanPeakNcc: detections.length > 0 ? nccSum / detections.length : 0,
      medianLatencySamples: validLatencies.length > 0 ? median(validLatencies) : null,
    });
  }

  let best: ChannelResult | null = null;
  for (const result of channelResults) {
    if (
      best === null ||
      result.validCount > best.validCount ||
      (result.validCount === best.validCount && result.meanPeakNcc > best.meanPeakNcc)
    ) {
      best = result;
    }
  }
  const bestChannel = best !== null && best.validCount > 0 ? best.channel : null;

  let stats: LoopbackStats | null = null;
  if (bestChannel !== null && best !== null) {
    const lat = best.detections
      .filter((d) => d.valid && d.latencySamples !== null)
      .map((d) => d.latencySamples as number)
      .sort((a, b) => a - b);
    const n = lat.length;
    const mean = lat.reduce((acc, v) => acc + v, 0) / n;
    let std: number | null = null;
    if (n >= 2) {
      const ss = lat.reduce((acc, v) => acc + (v - mean) * (v - mean), 0);
      std = Math.sqrt(ss / (n - 1));
    }
    const toMs = (samples: number) => (samples / sampleRateHz) * 1000;
    stats = {
      validCount: n,
      medianSamples: median(lat),
      medianMs: toMs(median(lat)),
      meanSamples: mean,
      meanMs: toMs(mean),
      stdSamples: std,
      stdMs: std === null ? null : toMs(std),
      minSamples: lat[0],
      maxSamples: lat[n - 1],
      spreadSamples: lat[n - 1] - lat[0],
      spreadMs: toMs(lat[n - 1] - lat[0]),
    };
  }

  return { channels: channelResults, bestChannel, stats };
}
