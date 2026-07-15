// loop-latency.ts — H/W 루프백 지연 측정의 렌더러측 DSP.
//
// window.audioLoopback.measure(opts)가 돌려주는 { header, pcm(Int16 인터리브) }과, 렌더러가
// --ref로 넘긴(=이미 알고 있는) 참조 신호(refSignal)를 대조해 왕복 지연을 계산한다. duplex 헬퍼는
// 단일 IOProc(단일 클럭)으로 참조 신호를 emitFrames[]에 방출하며 같은 콜백에서 입력을 캡처하므로:
//
//     왕복 지연(프레임) = (입력에서 참조 신호가 검출된 절대 프레임) − (방출한 프레임)
//
// 방출 프레임 e 마다 [e, e+maxDelayFrames] 창에서 참조 신호와의 매치드 필터(교차상관) 최댓값
// 위치를 찾아 lag = 지연으로 삼는다. 참조가 단일 임펄스([1,0,…])면 이는 곧 피크 검출과 같다.
// 헬퍼는 재생·캡처를 별도 스트림으로 열지 않으므로(단일 장치 duplex) 시작 오프셋 오염이 없다.
//
// 헬퍼/IPC 계약: electron/native/audio-device-helper/mac.swift(runDuplex),
// electron/ipc/audio-loopback.js, electron/preload.js(window.audioLoopback), 그리고
// src/shared/types/electron-bridge.d.ts 참조.

/** duplex 헬퍼가 첫 줄 JSON으로 보내는 헤더(electron-bridge.d.ts의 LoopbackHeader와 동일 형태) */
export interface LoopbackHeader {
  success: boolean;
  error?: string;
  device?: string;
  deviceUID?: string;
  channels: number; // stdout PCM의 인터리브 채널 수
  actual: { sampleRate: number; bufferSize: number | null };
  refLen: number;
  emitFrames: number[];
  maxDelayFrames: number;
  totalFrames: number;
  analysisChannel: number; // 왕복 검출에 쓸 입력 채널(보통 0)
}

/** window.audioLoopback.measure() 반환 형태 */
export interface LoopbackMeasureResult {
  success: boolean;
  error?: string;
  header?: LoopbackHeader;
  pcm?: Uint8Array; // Int16 인터리브
}

/** 방출 1회(버스트)의 왕복 지연 */
export interface BurstLatency {
  emitFrame: number;
  delayFrames: number;
  delayMs: number;
  peak: number; // 매치드 필터 정규화 진폭(참조 에너지로 나눈 값)
  snr: number; // peak / 창 노이즈 플로어
  hit: boolean; // SNR·절대 진폭 문턱을 넘겨 유효로 판정됐는지
}

/** 버퍼 크기 1개에 대한 요약 */
export interface BufferLatencyResult {
  requestedBuffer: number;
  actualBuffer: number | null;
  sampleRate: number;
  bursts: BurstLatency[];
  hits: number;
  total: number;
  medianMs: number | null;
  meanMs: number | null;
  sdMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  error?: string;
}

/** 유효 버스트 판정 문턱 — 피크가 창 노이즈 플로어의 N배 이상이고 절대 진폭이 미소치 이상 */
const SNR_HIT = 4;
const ABS_FLOOR = 0.0005;

/** 단일 임펄스 참조 [1,…,1,0,…] (len개 1.0). raw Float32 mono. */
export function buildImpulseRef(len = 1): Float32Array {
  const ref = new Float32Array(Math.max(1, len));
  ref.fill(1.0);
  return ref;
}

/** Float32 참조를 헬퍼 --ref(raw little-endian Float32)로 보낼 바이트로 복사 */
export function refToBytes(ref: Float32Array): Uint8Array {
  return new Uint8Array(ref.buffer.slice(ref.byteOffset, ref.byteOffset + ref.byteLength));
}

/** Int16 인터리브 PCM(Uint8Array)에서 한 채널만 Float 평면으로 (byteOffset 홀수여도 안전) */
export function extractChannelInt16(
  pcm: Uint8Array,
  channels: number,
  ch: number,
): Float32Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const frames = Math.floor(pcm.byteLength / 2 / channels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    out[i] = view.getInt16((i * channels + ch) * 2, true) / 32768;
  }
  return out;
}

function summarize(v: number[]) {
  if (v.length === 0) {
    return { median: null, mean: null, sd: null, min: null, max: null };
  }
  const s = [...v].sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return {
    median: s[Math.floor(s.length / 2)],
    mean,
    sd,
    min: s[0],
    max: s[s.length - 1],
  };
}

/**
 * 방출 프레임 e 이후 [e, e+maxDelay] 창에서 참조와의 매치드 필터 최댓값 위치 → 왕복 지연.
 * 노이즈 플로어는 창 |x|의 중앙값으로 근사한다.
 */
function measureBurst(
  x: Float32Array,
  ref: Float32Array,
  emit: number,
  maxDelay: number,
  refEnergy: number,
): BurstLatency {
  const refLen = ref.length;
  const lastLag = Math.min(maxDelay, x.length - emit - refLen);
  let bestLag = 0;
  let bestPeak = 0;
  const absVals: number[] = [];
  for (let lag = 0; lag <= lastLag; lag++) {
    let acc = 0;
    const base = emit + lag;
    for (let k = 0; k < refLen; k++) acc += x[base + k] * ref[k];
    const amp = Math.abs(acc) / refEnergy; // 참조 에너지로 정규화 → x의 매치 진폭 추정
    absVals.push(amp);
    if (amp > bestPeak) {
      bestPeak = amp;
      bestLag = lag;
    }
  }
  // 노이즈 플로어 = 매치드 필터 출력의 중앙값(피크 제외 근사)
  const sorted = [...absVals].sort((a, b) => a - b);
  const noise = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const snr = bestPeak / (noise + 1e-9);
  return {
    emitFrame: emit,
    delayFrames: bestLag,
    delayMs: 0, // analyzeBuffer에서 sampleRate로 환산
    peak: bestPeak,
    snr,
    hit: snr >= SNR_HIT && bestPeak >= ABS_FLOOR,
  };
}

/** 한 버퍼 크기 측정본(header+pcm) → 왕복 지연 요약 */
export function analyzeBuffer(
  ref: Float32Array,
  header: LoopbackHeader,
  pcm: Uint8Array,
  requestedBuffer: number,
): BufferLatencyResult {
  const sampleRate = header.actual.sampleRate || 48000;
  const x = extractChannelInt16(pcm, header.channels, header.analysisChannel);
  let refEnergy = 0;
  for (let k = 0; k < ref.length; k++) refEnergy += ref[k] * ref[k];
  refEnergy = refEnergy || 1;

  const bursts: BurstLatency[] = header.emitFrames.map((e) => {
    const b = measureBurst(x, ref, e, header.maxDelayFrames, refEnergy);
    b.delayMs = (b.delayFrames / sampleRate) * 1000;
    return b;
  });
  const hitMs = bursts.filter((b) => b.hit).map((b) => b.delayMs);
  const st = summarize(hitMs);
  return {
    requestedBuffer,
    actualBuffer: header.actual.bufferSize,
    sampleRate,
    bursts,
    hits: hitMs.length,
    total: bursts.length,
    medianMs: st.median,
    meanMs: st.mean,
    sdMs: st.sd,
    minMs: st.min,
    maxMs: st.max,
  };
}

/** 저장(JSON) 페이로드 형태 — 다운로드용 */
export interface LoopbackExport {
  meta: {
    createdAt: string;
    deviceUID: string;
    deviceName: string | null;
    channels: number;
    sampleRate: number;
    impulseLen: number;
    burstCount: number;
    note: string;
  };
  results: BufferLatencyResult[];
}
