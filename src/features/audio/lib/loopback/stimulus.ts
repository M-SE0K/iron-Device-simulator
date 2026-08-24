import { LoopbackConfigError, type LoopbackConfig, type LoopbackStimulusMeta } from "./types";

export interface LoopbackStimulus extends LoopbackStimulusMeta {
  /** 인터리브 스테레오 [L0,R0,...] — L/R 동일 신호. 헬퍼에 --ref 로 업로드된다. */
  refPcm: Float32Array;
  /** 모노 버스트 파형 — refPcm에 기록된 값과 비트 동일(둘 다 같은 Float32 양자화를 거침).
   * 분석(매치드 필터)이 이 배열을 그대로 템플릿으로 쓴다. */
  template: Float32Array;
}

/* 전 구간 Float64 배열 2n + 프리픽스 에너지 n 을 채널당 잡으므로 상한을 둔다
 * (4M 샘플 ≈ 48 kHz 83 s / 384 kHz 10.4 s, 채널당 ~64 MB 일시 사용). */
const MAX_TOTAL_FRAMES = 4_000_000;
const MAX_DURATION_S = 30;

/** ms → 샘플. 반올림 후 최소 1 — 이후 모든 산술은 정수 샘플로만 한다. */
export function msToSamples(ms: number, sampleRate: number): number {
  return Math.max(1, Math.round((ms * sampleRate) / 1000));
}

function stimulusFrameLayout(cfg: LoopbackConfig) {
  const burstLen = msToSamples(cfg.burstMs, cfg.sampleRate);
  const maxLag = msToSamples(cfg.maxLatencyMs, cfg.sampleRate);
  const leadIn = msToSamples(cfg.leadInMs, cfg.sampleRate);
  const guard = msToSamples(cfg.guardMs, cfg.sampleRate);
  /* 검색창 k 가 만지는 마지막 샘플은 e_k+maxLag+burstLen−1 = e_{k+1}−guard−1 이므로
   * 창들이 항상 서로소다 — 인접 버스트가 매치드 필터 창에 절대 섞이지 않는다. */
  const spacing = burstLen + maxLag + guard;
  const totalFrames = leadIn + (cfg.burstCount - 1) * spacing + burstLen + maxLag + guard;
  return { burstLen, maxLag, leadIn, guard, spacing, totalFrames };
}

/** 실행 불가능한 설정을 사람이 읽을 수 있는 문장 목록으로 반환(빈 배열 = 유효). */
export function validateLoopbackConfig(cfg: LoopbackConfig): string[] {
  const errors: string[] = [];
  const intIn = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;

  if (!intIn(cfg.sampleRate, 8000, 384000)) errors.push("Sample rate must be an integer between 8000 and 384000 Hz.");
  if (!intIn(cfg.bufferSize, 1, 1_000_000)) errors.push("Buffer size must be a positive integer.");
  if (!intIn(cfg.channels, 2, 64)) errors.push("Capture channels must be an integer between 2 and 64.");
  if (!intIn(cfg.outputChannel, 0, 63)) errors.push("Output channel must be an integer between 0 and 63.");
  if (!intIn(cfg.burstCount, 1, 32)) errors.push("Burst count must be an integer between 1 and 32.");
  if (!(cfg.burstFreqHz >= 20 && cfg.burstFreqHz <= cfg.sampleRate * 0.45))
    errors.push(`Burst frequency must be between 20 Hz and 45% of the sample rate (${Math.floor(cfg.sampleRate * 0.45)} Hz).`);
  if (!(cfg.burstMs >= 1 && cfg.burstMs <= 100)) errors.push("Burst length must be between 1 and 100 ms.");
  if (!(cfg.amplitude > 0 && cfg.amplitude <= 1)) errors.push("Amplitude must be within (0, 1].");
  if (!(cfg.maxLatencyMs >= 20 && cfg.maxLatencyMs <= 2000)) errors.push("Max latency window must be between 20 and 2000 ms.");
  if (!(cfg.leadInMs >= 0 && cfg.leadInMs <= 2000)) errors.push("Lead-in must be between 0 and 2000 ms.");
  if (!(cfg.guardMs >= 20 && cfg.guardMs <= 2000)) errors.push("Guard gap must be between 20 and 2000 ms.");
  if (!(cfg.nccThreshold >= 0.05 && cfg.nccThreshold <= 0.99)) errors.push("NCC threshold must be between 0.05 and 0.99.");
  if (errors.length > 0) return errors;

  const { totalFrames } = stimulusFrameLayout(cfg);
  if (totalFrames > MAX_TOTAL_FRAMES || totalFrames / cfg.sampleRate > MAX_DURATION_S) {
    errors.push(
      `Stimulus would be ${(totalFrames / cfg.sampleRate).toFixed(1)} s (${totalFrames} frames) — ` +
      `reduce burst count or the max latency window (limit ${MAX_DURATION_S} s / ${MAX_TOTAL_FRAMES} frames).`,
    );
  }
  return errors;
}

/** 버스트 열 자극 합성. 방출 오프셋(emissionSamples)은 구성 시점에 확정되는 정수이며,
 * 이후 측정의 참값(ground truth)으로 그대로 쓰인다. */
export function buildLoopbackStimulus(cfg: LoopbackConfig): LoopbackStimulus {
  const errors = validateLoopbackConfig(cfg);
  if (errors.length > 0) throw new LoopbackConfigError(errors.join(" "));

  const { burstLen, maxLag, leadIn, spacing, totalFrames } = stimulusFrameLayout(cfg);

  /* Hann 윈도 사인 버스트 — 단일 임펄스보다 대역 제한 경로(AA 필터·아날로그단)를 잘 통과해
   * 매치드 필터 피크가 안정적이다. 끝점이 0이라 방출 시 클릭도 없다. */
  const template = new Float32Array(burstLen);
  for (let i = 0; i < burstLen; i++) {
    const w = burstLen === 1 ? 1 : 0.5 * (1 - Math.cos((2 * Math.PI * i) / (burstLen - 1)));
    template[i] = cfg.amplitude * w * Math.sin((2 * Math.PI * cfg.burstFreqHz * i) / cfg.sampleRate);
  }

  const refPcm = new Float32Array(totalFrames * 2);
  const emissionSamples: number[] = [];
  for (let k = 0; k < cfg.burstCount; k++) {
    const e = leadIn + k * spacing;
    emissionSamples.push(e);
    for (let i = 0; i < burstLen; i++) {
      refPcm[(e + i) * 2] = template[i];
      refPcm[(e + i) * 2 + 1] = template[i];
    }
  }

  return {
    refPcm,
    template,
    emissionSamples,
    totalFrames,
    burstLenSamples: burstLen,
    spacingSamples: spacing,
    leadInSamples: leadIn,
    maxLagSamples: maxLag,
  };
}
