/* pcm-kit — 파형 엔벌로프(min/max 버킷) 집계의 벌크 커널 래퍼.
 *
 * native/pcm-kit/pcm_kit.c 를 컴파일한 public/wasm/pcm_kit.wasm(글루 JS 없는 독립
 * 모듈)을 지연 로드해 쓰고, 로드 전/실패/미지원(SIMD 없는 구형 WebView) 환경에서는
 * 동일 산식의 JS 폴백으로 동작한다 — 호출부(ChannelWaveStore.addSamples)는 어느 쪽이
 * 실행되는지 모른다. 커널은 호출당 무상태라 스트림 중간에 JS→WASM 전환이 일어나도
 * 안전하다.
 *
 * 버킷 경계 산식(샘플 i 소속 버킷 = floor((startSec + i/rate)/bucketSec)를 버킷당
 * 경계 인덱스 1회 계산으로 재구성한 것)은 C 커널과 이 파일의 폴백이 반드시 동일해야
 * 한다 — 수정 시 양쪽을 함께 고칠 것.
 */

import { getEnvelopeMode } from "@/shared/lib/iron-perf";

const WASM_DIR = process.env.NEXT_PUBLIC_WASM_DIR || "/wasm";

const INT16_NORM = 1 / 0x8000;

/* 커널이 버킷 순회 폭주를 막으려고 거부하는 하한(pcm_kit.c 와 동일) — 이보다 작은
 * 버킷은 실사용에 없지만, 방어적으로 JS 의 per-sample 경로가 처리한다. */
const MIN_SAMPLES_PER_BUCKET = 0.5;

/* pcm_kit.c 의 스크래치/출력 용량 미러 — 청크 분해(envelopeChunkFrames)가 이 상수로
 * 결정되고, JS 폴백도 같은 분해를 쓰므로 두 경로의 버킷 경계 산출이 비트 단위로
 * 일치한다(분해가 다르면 부동소수점 타이 경계에서 ±1샘플씩 어긋난다). C 쪽 용량을
 * 바꾸면 여기도 함께 바꿀 것 — 로드 시 검증해 불일치면 커널을 쓰지 않는다. */
const IN_CAP_BYTES = 1 << 20;
const OUT_CAP = 8192;

export type PcmSource = Int16Array | Float32Array;

/** mins/maxs 는 다음 청크 처리 전까지만 유효한 뷰 — 콜백 안에서 즉시 병합할 것. */
export type EnvelopeEmit = (
  firstBucket: number,
  count: number,
  mins: Float32Array,
  maxs: Float32Array,
) => void;

export interface EnvelopeStats {
  peak: number;
  sumSq: number;
}

interface KitInstance {
  envelope: (
    format: number, frames: number, channels: number, channel: number,
    startSec: number, sampleRate: number, bucketSec: number, maxBuckets: number,
  ) => number;
  inI16: Int16Array;
  inF32: Float32Array;
  mins: Float32Array;
  maxs: Float32Array;
  stats: Float64Array;
}

let kitInstance: KitInstance | null = null;
let loadState: "idle" | "loading" | "failed" = "idle";

function ensureKitLoading(): void {
  if (loadState !== "idle" || typeof window === "undefined") return;
  loadState = "loading";
  void (async () => {
    try {
      const res = await fetch(`${WASM_DIR}/pcm_kit.wasm`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bytes, {});
      const ex = instance.exports as unknown as {
        memory: WebAssembly.Memory;
        _initialize?: () => void;
        pcmkit_envelope: KitInstance["envelope"];
        pcmkit_in: () => number;
        pcmkit_min: () => number;
        pcmkit_max: () => number;
        pcmkit_stats: () => number;
        pcmkit_in_cap: () => number;
        pcmkit_out_cap: () => number;
      };
      ex._initialize?.();
      const inCapBytes = ex.pcmkit_in_cap();
      const outCap = ex.pcmkit_out_cap();
      if (inCapBytes !== IN_CAP_BYTES || outCap !== OUT_CAP) {
        throw new Error(`용량 계약 불일치: wasm ${inCapBytes}/${outCap} vs ts ${IN_CAP_BYTES}/${OUT_CAP}`);
      }
      const buf = ex.memory.buffer;
      const inPtr = ex.pcmkit_in();
      kitInstance = {
        envelope: ex.pcmkit_envelope,
        inI16: new Int16Array(buf, inPtr, inCapBytes / 2),
        inF32: new Float32Array(buf, inPtr, inCapBytes / 4),
        mins: new Float32Array(buf, ex.pcmkit_min(), outCap),
        maxs: new Float32Array(buf, ex.pcmkit_max(), outCap),
        stats: new Float64Array(buf, ex.pcmkit_stats(), 4),
      };
    } catch (err) {
      loadState = "failed";
      console.warn("[pcm-kit] WASM 커널 로드 실패 — JS 폴백으로 계속합니다:", err);
    }
  })();
}

/** 호출당 프레임 상한: 입력 스크래치 용량 + "버킷 출력이 OUT_CAP을 절대 못 넘는" 양
 * (버킷 span ≈ frames/(bucketSec·rate) + 2) 둘 다 만족. WASM/JS 폴백이 같은 분해를
 * 쓰도록 공통 계층에서 계산한다(동등성 테스트도 이 함수로 분해를 재현한다). */
export function envelopeChunkFrames(
  channels: number,
  isI16: boolean,
  bucketSec: number,
  sampleRate: number,
): number {
  const inCapFrames = Math.floor(IN_CAP_BYTES / (channels * (isI16 ? 2 : 4)));
  const bucketCapFrames = Math.floor((OUT_CAP - 4) * bucketSec * sampleRate);
  return Math.max(1, Math.min(inCapFrames, bucketCapFrames));
}

/**
 * 인터리브 PCM에서 한 채널을 골라 버킷별 min/max 엔벌로프와 블록 stats(peak/sumSq)를
 * 집계한다. 버킷 인덱스가 maxBuckets 를 넘는 샘플은 버킷에서는 제외되지만 stats 에는
 * 포함된다(기존 wave-store 의미 보존). 결과는 emit 콜백으로 버킷 구간 단위로 전달된다.
 * 청크 분해는 WASM/JS 폴백 공통이라 두 경로의 버킷 결과가 동일하다(sumSq 만 누적
 * 정밀도 차이로 미세하게 다를 수 있음).
 */
export function aggregateEnvelope(
  src: PcmSource,
  channels: number,
  channel: number,
  frames: number,
  startSec: number,
  sampleRate: number,
  bucketSec: number,
  maxBuckets: number,
  emit: EnvelopeEmit,
): EnvelopeStats {
  if (frames <= 0 || channels <= 0 || channel < 0 || channel >= channels) {
    return { peak: 0, sumSq: 0 };
  }
  if (!(sampleRate > 0) || !(bucketSec > 0) || !(startSec >= 0)) return { peak: 0, sumSq: 0 };
  ensureKitLoading();

  if (bucketSec * sampleRate < MIN_SAMPLES_PER_BUCKET) {
    return aggregateJsSparse(src, channels, channel, frames, startSec, sampleRate, bucketSec, maxBuckets, emit);
  }

  const isI16 = src instanceof Int16Array;
  const framesPerCall = envelopeChunkFrames(channels, isI16, bucketSec, sampleRate);
  /* 호출 중간에 로드가 끝나도 이 호출 안에서는 경로를 바꾸지 않는다.
   * "js" 모드(__ironPerf.envelopeMode, A/B 측정)는 커널을 강제로 우회한다. */
  const kit = getEnvelopeMode() === "js" ? null : kitInstance;

  let peak = 0;
  let sumSq = 0;
  let off = 0;
  while (off < frames) {
    const n = Math.min(framesPerCall, frames - off);
    const chunkStartSec = startSec + off / sampleRate;
    const r = kit
      ? wasmChunk(kit, src, channels, channel, off, n, chunkStartSec, sampleRate, bucketSec, maxBuckets, emit)
      : jsChunk(src, channels, channel, off, n, chunkStartSec, sampleRate, bucketSec, maxBuckets, emit);
    if (r.peak > peak) peak = r.peak;
    sumSq += r.sumSq;
    off += n;
  }
  return { peak, sumSq };
}

function wasmChunk(
  kit: KitInstance,
  src: PcmSource,
  channels: number,
  channel: number,
  off: number,
  frames: number,
  startSec: number,
  sampleRate: number,
  bucketSec: number,
  maxBuckets: number,
  emit: EnvelopeEmit,
): EnvelopeStats {
  const isI16 = src instanceof Int16Array;
  const view = src.subarray(off * channels, (off + frames) * channels);
  if (isI16) kit.inI16.set(view as Int16Array);
  else kit.inF32.set(view as Float32Array);

  const count = kit.envelope(isI16 ? 0 : 1, frames, channels, channel, startSec, sampleRate, bucketSec, maxBuckets);
  if (count < 0) {
    /* 계약상 도달 불가(청크 상한을 공통 계층이 보장) — 만일을 위해 이 청크는 JS로. */
    console.warn(`[pcm-kit] 커널 오류 ${count} — 이 구간은 JS 폴백으로 처리합니다.`);
    return jsChunk(src, channels, channel, off, frames, startSec, sampleRate, bucketSec, maxBuckets, emit);
  }
  if (count > 0) {
    emit(kit.stats[2], count, kit.mins.subarray(0, count), kit.maxs.subarray(0, count));
  }
  return { peak: kit.stats[0], sumSq: kit.stats[1] };
}

/* JS 폴백의 단일 청크 처리 — pcm_kit.c 의 phase 2 루프를 1:1 미러링한다(경계 산식·
 * 센티널·OUT_CAP 상한까지). 버킷 min/max 는 f32 로 저장해 커널과 비트 동일하고,
 * sumSq 만 누적 정밀도(커널은 f32 부분합)가 달라 미세 차이가 난다. */
let jsScratch: { mins: Float32Array; maxs: Float32Array } | null = null;

function jsChunk(
  src: PcmSource,
  channels: number,
  channel: number,
  off: number,
  frames: number,
  startSec: number,
  sampleRate: number,
  bucketSec: number,
  maxBuckets: number,
  emit: EnvelopeEmit,
): EnvelopeStats {
  const scratch = (jsScratch ??= { mins: new Float32Array(OUT_CAP), maxs: new Float32Array(OUT_CAP) });
  const scale = src instanceof Int16Array ? INT16_NORM : 1;

  let peak = 0;
  let sumSq = 0;
  let b = Math.floor(startSec / bucketSec);
  if (b < 0) b = 0;

  let i = 0;
  let outN = 0;
  let outFirst = -1;
  while (i < frames) {
    const fEnd = ((b + 1) * bucketSec - startSec) * sampleRate;
    let iEnd = fEnd >= frames ? frames : (fEnd <= i ? i : Math.ceil(fEnd));
    if (iEnd > frames) iEnd = frames;
    const inRange = b < maxBuckets && outN < OUT_CAP;

    if (iEnd > i) {
      let mn = Infinity;
      let mx = -Infinity;
      let ss = 0;
      let idx = (off + i) * channels + channel;
      for (let s = i; s < iEnd; s++, idx += channels) {
        const v = src[idx] * scale;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        ss += v * v;
      }
      sumSq += ss;
      const am = -mn > mx ? -mn : mx;
      if (am > peak) peak = am;
      if (inRange) {
        if (outFirst < 0) outFirst = b;
        scratch.mins[outN] = mn;
        scratch.maxs[outN] = mx;
        outN++;
      }
    } else if (inRange && outFirst >= 0) {
      scratch.mins[outN] = Infinity;
      scratch.maxs[outN] = -Infinity;
      outN++;
    }
    i = iEnd;
    b++;
  }

  if (outN > 0) emit(outFirst, outN, scratch.mins.subarray(0, outN), scratch.maxs.subarray(0, outN));
  return { peak, sumSq };
}

/* 버킷이 샘플 간격보다 훨씬 작은 퇴화 케이스(실사용 파라미터로는 도달하지 않음) —
 * 버킷 span 이 폭주할 수 있어 샘플별 floor 산식으로 개별 emit 한다. */
function aggregateJsSparse(
  src: PcmSource,
  channels: number,
  channel: number,
  frames: number,
  startSec: number,
  sampleRate: number,
  bucketSec: number,
  maxBuckets: number,
  emit: EnvelopeEmit,
): EnvelopeStats {
  const scale = src instanceof Int16Array ? INT16_NORM : 1;
  const step = 1 / sampleRate;
  const one = { mn: new Float32Array(1), mx: new Float32Array(1) };
  let peak = 0;
  let sumSq = 0;
  let curB = -1;
  let mn = Infinity;
  let mx = -Infinity;
  const flushBucket = () => {
    if (curB < 0 || curB >= maxBuckets || mn > mx) return;
    one.mn[0] = mn;
    one.mx[0] = mx;
    emit(curB, 1, one.mn, one.mx);
  };
  for (let s = 0; s < frames; s++) {
    const v = src[s * channels + channel] * scale;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sumSq += v * v;
    const b = Math.floor((startSec + s * step) / bucketSec);
    if (b !== curB) {
      flushBucket();
      curB = b;
      mn = v;
      mx = v;
    } else {
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  }
  flushBucket();
  return { peak, sumSq };
}
