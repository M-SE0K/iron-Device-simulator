/**
 * H/W 루프백 왕복 지연 측정 (--dev 계측 빌드 전용) — 타입 정의.
 *
 * 측정 원리: play-capture --ref 헬퍼는 단일 IOProc(단일 클록)의 같은 콜백 사이클에서
 * "ref 샘플 i 방출"과 "캡처 샘플 i 수신"을 처리한다(mac.swift runPlayCapture — 출력에
 * refL[playPos+f]를 쓰고 입력을 stdout에 쓴 뒤 playPos += framesThis). 따라서 왕복 지연은
 * 순수 샘플 도메인 연산 `검출 도착 샘플 − ref 내 방출 샘플` 로 구하며, 출력 안전 오프셋 +
 * DAC/ADC 변환 + 아날로그 경로 + 입력 버퍼링이 전부 포함된 "앱 경계에서 본 실제 왕복"이다.
 * 벽시계(performance.now / Date)는 어떤 경로로도 측정값에 들어가지 않는다 — 워치독과
 * 참고 표시(wallStartToFirstChunkMs)에만 쓴다.
 */

export interface LoopbackConfig {
  /** Calibration 값 그대로 — 캡처 세션을 앱과 같은 조건으로 연다. */
  sampleRate: number;
  bufferSize: number;
  channels: number;
  captureDeviceUID: string;
  outputChannel: number;
  /** 버스트 자극 파라미터 */
  burstCount: number;
  burstFreqHz: number;
  burstMs: number;
  /** 선형 진폭 (0, 1] — 전기 루프백 기준. 앰프/스피커가 물려 있으면 낮출 것. */
  amplitude: number;
  /** 검색창 상한 — 실제 왕복이 이보다 크면 window-edge 로 무효 처리된다. */
  maxLatencyMs: number;
  leadInMs: number;
  /** 검색창과 다음 버스트 사이 완충 — 잔향 꼬리가 다음 창을 오염시키지 않게 한다. */
  guardMs: number;
  /** 매치드 필터 피크 유효 판정 임계(정규화 교차상관 |NCC|). */
  nccThreshold: number;
}

export const LOOPBACK_DEFAULTS = {
  burstCount: 8,
  burstFreqHz: 1000,
  burstMs: 10,
  amplitude: 0.5,
  maxLatencyMs: 400,
  leadInMs: 300,
  guardMs: 100,
  nccThreshold: 0.5,
} as const;

export type LoopbackPhase = "uploading" | "capturing" | "analyzing";

export type BurstInvalidReason = "low-correlation" | "window-edge" | "capture-short";

export interface BurstDetection {
  burstIndex: number;
  /** ref 타임라인 내 버스트 시작(정수 샘플) — 합성 시점에 확정되는 참값. */
  emissionSample: number;
  /** 캡처 타임라인 내 검출 위치(포물선 보간 서브샘플). 무효면 null. */
  arrivalSample: number | null;
  latencySamples: number | null;
  latencyMs: number | null;
  peakNcc: number;
  peakAtWindowEdge: boolean;
  valid: boolean;
  invalidReason: BurstInvalidReason | null;
}

export interface ChannelResult {
  channel: number;
  detections: BurstDetection[];
  validCount: number;
  meanPeakNcc: number;
  medianLatencySamples: number | null;
}

export interface LoopbackStats {
  validCount: number;
  medianSamples: number;
  medianMs: number;
  meanSamples: number;
  meanMs: number;
  /** 표본 표준편차(n−1). 유효 버스트 2개 미만이면 null. */
  stdSamples: number | null;
  stdMs: number | null;
  minSamples: number;
  maxSamples: number;
  /** max−min — 단일 클록이라 정상 리그에서는 1샘플 미만이어야 한다. */
  spreadSamples: number;
  spreadMs: number;
}

export interface LoopbackIntegrity {
  refFramesSynthesized: number;
  /** 헬퍼 헤더의 refLen 에코 — 합성 프레임 수와 다르면 측정 자체를 중단한다. */
  refFramesEchoed: number | null;
  refLenMatches: boolean | null;
  /** 수신 총 바이트 ÷ (2·채널) — 프레임 수의 유일한 출처. */
  receivedFrames: number;
  /** 프레임 경계로 나눠떨어지지 않은 잔여 바이트 — 0이 아니면 스트림 무결성 위반. */
  trailingBytes: number;
  /** 마지막 버스트 검색창 끝 — 이만큼 수신돼야 전 버스트를 판정할 수 있다. */
  coverageEndSample: number;
  framesCoverAllBursts: boolean;
  /** 스트림 유실 가드: 수신 ≥ 합성 ref 총 프레임. 헬퍼는 ref 종료 후에도 0.25 s 테일을
   * 더 흘리므로 정상 세션은 큰 여유로 만족한다. Windows 캡처는 1초 링 경유라 오버런 시
   * 콜백 단위로 드롭되고 stderr(앱이 버림)로만 보고되는데 — 첫 버스트 이전에 나면 spread
   * 로도 안 잡히는 균일 편향이 되므로 이 총량 하한이 그 케이스의 탐지선이다. */
  framesReachRefEnd: boolean;
  requestedSampleRate: number;
  /** ms 환산에 쓰는 실효 SR(헬퍼 actual). 샘플 도메인 결과에는 영향이 없다. */
  actualSampleRate: number;
  sampleRateMatches: boolean;
  requestedBufferSize: number;
  actualBufferSize: number | null;
  captureChannels: number;
  helperMode: string | null;
  playbackChannelL: number | null;
  /** null이면 헬퍼가 모노 폴백(R 출력 없음)한 것. */
  playbackChannelR: number | null;
  /** start() 완료 → 첫 캡처 청크 도착 벽시계(ms). 참고용 — 측정값 아님. */
  wallStartToFirstChunkMs: number | null;
}

export interface LoopbackStimulusMeta {
  totalFrames: number;
  burstLenSamples: number;
  spacingSamples: number;
  leadInSamples: number;
  maxLagSamples: number;
  emissionSamples: number[];
}

export interface LoopbackReport {
  startedAtIso: string;
  platform: string;
  device: { name: string | null; uid: string | null };
  config: LoopbackConfig;
  stimulus: LoopbackStimulusMeta;
  integrity: LoopbackIntegrity;
  channels: ChannelResult[];
  bestChannel: number | null;
  stats: LoopbackStats | null;
  wallDurationMs: number;
}

export class LoopbackConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopbackConfigError";
  }
}

export class LoopbackCancelledError extends Error {
  constructor() {
    super("Loopback measurement was cancelled.");
    this.name = "LoopbackCancelledError";
  }
}
