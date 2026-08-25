import { humanizeIpcError } from "@/shared/lib/ipc-error";
import { clampCaptureChannels } from "@/features/audio/lib/engine/core";
import { uploadPlaybackRef } from "@/features/audio/lib/playcapture-upload";
import { buildLoopbackStimulus } from "./stimulus";
import { CaptureByteSink } from "./capture-sink";
import { LoopbackStreamPump } from "./stream-pump";
import { analyzeLoopbackCapture } from "./analyze";
import {
  LoopbackCancelledError,
  type LoopbackConfig,
  type LoopbackIntegrity,
  type LoopbackPhase,
  type LoopbackReport,
} from "./types";

/* 헬퍼는 ref 종료 후 감쇠 꼬리(mac.swift tailFrames = 0.25 s)까지 캡처하고 exit 0 한다.
 * 진행률 분모·워치독 산정에만 쓰는 값 — 측정은 ref 타임라인 안에서 끝난다. */
const CAPTURE_TAIL_S = 0.25;
/* --stream 경로 프리필 — 대시보드 보호 재생(useNativeCapture)과 같은 값이라야 같은 조건의
 * 링 거동을 측정한다. */
const STREAM_PREFILL_MS = 40;
/* 자극을 재생 위치보다 앞서 보내는 여유. 링 용량은 max(prefill×8, 1 s)이므로 ×4 는 항상
 * 그 안이다 — 렌더러 지터는 흡수하면서 링을 넘치게 하지는 않는 선. */
const STREAM_LEAD_MULTIPLIER = 4;
/* 워치독 여유분 — 장치 열기/IPC 왕복까지 포함. 벽시계는 여기(행 감지)와 참고 표시에만 쓴다. */
const WATCHDOG_EXTRA_MS = 8000;
/* stream 경로 추가 여유 — 언더런이 나면 링을 비우는 데 자극 길이보다 오래 걸린다(측정하려는
 * 현상 자체다). 이걸 행으로 오인해 죽이지 않도록 넉넉히 준다. */
const STREAM_WATCHDOG_EXTRA_MS = 10000;
const PROGRESS_THROTTLE_MS = 100;

export interface LoopbackRunCallbacks {
  onPhase?: (phase: LoopbackPhase) => void;
  onCaptureProgress?: (receivedFrames: number, expectedFrames: number) => void;
}

export interface LoopbackRunHandle {
  promise: Promise<LoopbackReport>;
  /** 어느 단계에서든 중단 — 세션이 떠 있으면 stop()(ended 이벤트 억제)으로 헬퍼를 내린다. */
  cancel: () => void;
}

function mapStartError(error: string | undefined): string {
  if (error?.includes("device-has-no-output")) {
    return (
      "The selected Capture Device has no output channels, so a loopback burst can't be played. " +
      "Choose a combined input/output device (e.g. MCHStreamer) in Calibration."
    );
  }
  if (error?.includes("play-capture-already-running")) {
    return "Another play-capture session is already running (dashboard playback?). Stop it and retry.";
  }
  return humanizeIpcError(error, "Failed to start the loopback play-capture session.");
}

function mapEndCode(code: number | null): string {
  if (code === 4) {
    return "The helper timed out waiting for the stimulus prefill — the stream pump never filled the playback ring.";
  }
  if (code === 3) {
    return "Lost connection to the Capture Device during the measurement (e.g. USB disconnect). Reconnect and retry.";
  }
  if (code === null) return "The audio helper terminated abnormally during the measurement.";
  return `The audio helper exited unexpectedly (code ${code}).`;
}

/** 버스트 루프백 측정 한 회 실행.
 *
 * 시퀀스: 자극 합성 → (ref) --ref 업로드 | (stream) 없음 → play-capture 시작 →
 * (stream) self-clocking 펌프로 자극 주입 → 캡처 전체 수집(ended code 0까지) → 매치드 필터
 * 분석 → 리포트. 지연값은 전부 단일 IOProc 샘플 도메인에서 나온다. 두 경로의 의미 차이
 * (stream 은 H/W 왕복이 아니라 언더런이 얹힌 값)는 types.ts 상단 주석 참고.
 *
 * 이벤트 구독은 start() 호출 "전"에 걸어 첫 청크부터 유실 없이 받는다(브리지 ChannelHub가
 * 구독 전 도착분을 백로그로 버퍼링하지만, 그 512개 상한에도 기대지 않기 위함). 세션은
 * Rust 쪽 가드(play-capture-already-running)로 단일 실행이 보장되므로, 구독 중 도착하는
 * 청크는 전부 이 측정 세션의 것이다.
 */
export function startLoopbackMeasurement(
  config: LoopbackConfig,
  callbacks: LoopbackRunCallbacks = {},
): LoopbackRunHandle {
  let cancelRequested = false;
  let rejectCaptureWait: ((err: Error) => void) | null = null;
  let abortPump: (() => void) | null = null;

  const cancel = () => {
    if (cancelRequested) return;
    cancelRequested = true;
    abortPump?.();
    void window.audioPlayCapture?.stop();
    rejectCaptureWait?.(new LoopbackCancelledError());
  };

  const promise = run();
  return { promise, cancel };

  async function run(): Promise<LoopbackReport> {
    const bridge = window.audioPlayCapture;
    if (!bridge) {
      throw new Error("Loopback measurement needs the packaged Tauri app — the audioPlayCapture bridge is unavailable.");
    }

    const startedAtIso = new Date().toISOString();
    const wallRunStart = performance.now();
    const stimulus = buildLoopbackStimulus(config);
    const captureChannels = clampCaptureChannels(config.channels);
    const streamPath = stimulus.path === "stream";

    let refWriteId: string | undefined;
    if (stimulus.path === "ref") {
      callbacks.onPhase?.("uploading");
      refWriteId = await uploadPlaybackRef(bridge, stimulus.refPcm);
      if (cancelRequested) {
        void bridge.cancelWrite({ writeId: refWriteId });
        throw new LoopbackCancelledError();
      }
    }

    const sink = new CaptureByteSink();
    let pump: LoopbackStreamPump | null = null;
    let acceptChunks = false;
    let wallAfterStart: number | null = null;
    let wallFirstChunk: number | null = null;
    let lastProgressWall = 0;
    let expectedFrames = 0;

    let offData: (() => void) | null = null;
    let offEnded: (() => void) | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    try {
      offData = bridge.onData((chunk) => {
        if (!acceptChunks) return;
        if (wallFirstChunk === null) wallFirstChunk = performance.now();
        sink.push(chunk);
        /* 자기 클록 펌프 — 수신 캡처 프레임이 곧 "다음 자극을 밀어 넣어도 되는" 크레딧이다. */
        pump?.pumpTo(sink.frameCount(captureChannels));
        const now = performance.now();
        if (now - lastProgressWall >= PROGRESS_THROTTLE_MS) {
          lastProgressWall = now;
          callbacks.onCaptureProgress?.(sink.frameCount(captureChannels), expectedFrames);
        }
      });
      let resolveCaptureWait: ((info: { code: number | null }) => void) | null = null;
      const captureDone = new Promise<{ code: number | null }>((resolve, reject) => {
        resolveCaptureWait = resolve;
        rejectCaptureWait = reject;
      });
      /* start 실패로 captureDone을 await 하지 못한 채 cancel/워치독이 reject 하면 unhandled
       * rejection이 된다 — 소비자가 없어도 안전하게 no-op 캐치를 걸어 둔다. */
      captureDone.catch(() => {});
      offEnded = bridge.onEnded((info) => resolveCaptureWait?.(info));

      callbacks.onPhase?.("capturing");
      acceptChunks = true;
      const res = await bridge.start({
        sampleRate: config.sampleRate,
        bufferSize: config.bufferSize,
        channels: captureChannels,
        deviceUID: config.captureDeviceUID.trim() || undefined,
        ...(streamPath
          ? { stream: true, prefillMs: STREAM_PREFILL_MS }
          : { refWriteId, refChannels: 2 as const }),
        outputChannel: config.outputChannel,
        /* R은 best-effort — 장치에 출력이 1채널뿐이면 헬퍼가 조용히 모노 폴백한다
         * (playbackChannelR: null 에코). 파일 재생 경로와 같은 규약. */
        outputChannelR: config.outputChannel + 1,
      });
      if (cancelRequested) {
        void bridge.stop();
        throw new LoopbackCancelledError();
      }
      if (!res.success) throw new Error(mapStartError(res.error));

      const actualRate =
        res.actual?.sampleRate && res.actual.sampleRate > 0 ? res.actual.sampleRate : config.sampleRate;
      const actualChannels = res.channels ?? captureChannels;
      if (actualChannels !== captureChannels) {
        /* 채널 수가 요청과 다르면 바이트→프레임 재구성 자체가 어긋난다 — 측정 무효. */
        void bridge.stop();
        throw new Error(
          `Helper opened ${actualChannels} capture channels (requested ${captureChannels}) — aborted to keep frame indexing exact.`,
        );
      }
      const refFramesEchoed = typeof res.refLen === "number" ? res.refLen : null;
      if (refFramesEchoed !== null && refFramesEchoed !== stimulus.totalFrames) {
        /* 업로드/파일 해석이 어긋나면 방출 타임라인(참값)을 신뢰할 수 없다. */
        void bridge.stop();
        throw new Error(
          `Ref length mismatch — synthesized ${stimulus.totalFrames} frames but the helper loaded ${refFramesEchoed}. Aborted.`,
        );
      }
      const expectedMode = streamPath ? "play-capture-stream" : "play-capture";
      if (res.mode != null && res.mode !== expectedMode) {
        /* 요청한 경로와 다른 모드로 열렸다면 측정 대상 자체가 다르다. */
        void bridge.stop();
        throw new Error(`Helper opened "${res.mode}" but the ${config.path} path needs "${expectedMode}". Aborted.`);
      }

      const prefillFramesEchoed = streamPath && typeof res.prefillFrames === "number" ? res.prefillFrames : null;
      if (stimulus.path === "stream") {
        /* 헤더의 prefillFrames 가 IOProc 시작 게이트다 — 에코가 없으면 프리필 기준을
         * 요청값에서 직접 환산한다(구버전 헬퍼 호환). */
        const prefill = prefillFramesEchoed ?? Math.max(1, Math.round((STREAM_PREFILL_MS / 1000) * actualRate));
        pump = new LoopbackStreamPump(
          bridge,
          stimulus.refPcmI16,
          prefill * STREAM_LEAD_MULTIPLIER,
          (err) => {
            void bridge.stop();
            rejectCaptureWait?.(err);
          },
        );
        abortPump = () => pump?.abort();
        /* 프리필이 차야 헬퍼가 AudioDeviceStart 를 부른다 — 여기서 시동을 건다. */
        pump.prime();
      }

      expectedFrames = stimulus.totalFrames + Math.ceil(CAPTURE_TAIL_S * actualRate);
      const watchdogMs =
        Math.ceil((expectedFrames / actualRate) * 1000) +
        WATCHDOG_EXTRA_MS +
        (streamPath ? STREAM_WATCHDOG_EXTRA_MS : 0);
      watchdog = setTimeout(() => {
        void bridge.stop();
        rejectCaptureWait?.(
          new Error(`Capture didn't finish within ${Math.round(watchdogMs / 1000)} s — helper hang or stalled stream.`),
        );
      }, watchdogMs);
      wallAfterStart = performance.now();

      const endInfo = await captureDone;
      acceptChunks = false;
      callbacks.onCaptureProgress?.(sink.frameCount(captureChannels), expectedFrames);
      if (endInfo.code !== 0) throw new Error(mapEndCode(endInfo.code));

      const receivedFrames = sink.frameCount(actualChannels);
      const trailingBytes = sink.trailingBytes(actualChannels);
      const lastEmission = stimulus.emissionSamples[stimulus.emissionSamples.length - 1];
      const coverageEndSample = lastEmission + stimulus.maxLagSamples + stimulus.burstLenSamples;
      const integrity: LoopbackIntegrity = {
        path: config.path,
        refFramesSynthesized: stimulus.totalFrames,
        refFramesEchoed,
        refLenMatches: refFramesEchoed === null ? null : refFramesEchoed === stimulus.totalFrames,
        sentFrames: pump === null ? null : pump.sentFrames,
        sentAllFrames: pump === null ? null : pump.completed,
        prefillFramesEchoed,
        receivedFrames,
        trailingBytes,
        coverageEndSample,
        framesCoverAllBursts: receivedFrames >= coverageEndSample,
        framesReachRefEnd: receivedFrames >= stimulus.totalFrames,
        requestedSampleRate: config.sampleRate,
        actualSampleRate: actualRate,
        sampleRateMatches: Math.abs(actualRate - config.sampleRate) < 1,
        requestedBufferSize: config.bufferSize,
        actualBufferSize: res.actual?.bufferSize ?? null,
        captureChannels: actualChannels,
        helperMode: res.mode ?? null,
        playbackChannelL: res.playbackChannel ?? null,
        playbackChannelR: res.playbackChannelR ?? null,
        wallStartToFirstChunkMs:
          wallFirstChunk !== null && wallAfterStart !== null ? wallFirstChunk - wallAfterStart : null,
      };

      callbacks.onPhase?.("analyzing");
      const analysis = await analyzeLoopbackCapture(
        {
          interleaved: sink.toInt16(),
          channels: actualChannels,
          template: stimulus.template,
          emissionSamples: stimulus.emissionSamples,
          maxLagSamples: stimulus.maxLagSamples,
          nccThreshold: config.nccThreshold,
          sampleRateHz: actualRate,
        },
        { isCancelled: () => cancelRequested },
      );

      return {
        startedAtIso,
        platform: typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent : "",
        device: { name: res.device ?? null, uid: res.deviceUID ?? null },
        config,
        stimulus: {
          totalFrames: stimulus.totalFrames,
          burstLenSamples: stimulus.burstLenSamples,
          spacingSamples: stimulus.spacingSamples,
          leadInSamples: stimulus.leadInSamples,
          maxLagSamples: stimulus.maxLagSamples,
          emissionSamples: stimulus.emissionSamples,
        },
        integrity,
        channels: analysis.channels,
        bestChannel: analysis.bestChannel,
        stats: analysis.stats,
        wallDurationMs: performance.now() - wallRunStart,
      };
    } finally {
      acceptChunks = false;
      pump?.abort();
      abortPump = null;
      rejectCaptureWait = null;
      if (watchdog) clearTimeout(watchdog);
      offData?.();
      offEnded?.();
    }
  }
}
