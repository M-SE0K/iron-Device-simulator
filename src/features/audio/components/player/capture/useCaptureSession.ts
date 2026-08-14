"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnalysisFrame } from "@/features/audio/types";
import { createAnalysisSocket } from "@/features/audio/lib/engine/protocol/local-socket";
import type { SocketLike } from "@/features/audio/lib/engine/protocol/socket-types";
import { useCalibration } from "@/features/audio/components/calibration/CalibrationContext";
import { useErrorPopup } from "@/shared/components/error-popup/ErrorPopupContext";
import { recordPerfSample } from "@/shared/lib/iron-perf";
import { pcmFramesToWavBlob } from "@/features/audio/lib/codec/wav-encoder";
import { CHANNELS, SAMPLE_RATE, SAMPLES_PER_CH, BYTES_PER_SAMPLE } from "@/features/audio/lib/engine/core";
import { decodeProcessedPcmMessage } from "@/features/audio/lib/engine/protocol/analysis";
import { useNativeCapture, type NativeRawCapture } from "./useNativeCapture";
import { buildInitMessage } from "./build-init-message";
import type {
  CaptureSnapshot, CaptureStreamEvent, CaptureStreamListener, PlaybackStreamPump, UseCaptureSessionDeps,
} from "./types";

export type {
  CaptureSnapshot,
  CaptureStreamEvent,
  CaptureStreamListener,
  PlaybackMode,
  UseCaptureSessionDeps,
} from "./types";

function blobFromCapture(entry: NativeRawCapture | null): Blob | null {
  if (!entry || entry.frames.length === 0) return null;
  return pcmFramesToWavBlob(entry.frames, entry.sampleRate, entry.channels);
}

export function useCaptureSession(deps: UseCaptureSessionDeps) {
  const {
    status, onStatusChange, onFrameReceived, onStreamStart, inputParams, playbackMode = "protected",
  } = deps;
  const { values: calibration } = useCalibration();
  const { showError } = useErrorPopup();

  const [micError, setMicErrorState] = useState<string | null>(null);
  // 캡처/재생 세션 에러는 이 훅 한 곳에서만 세팅되므로, 여기서 전역
  // 팝업까지 같이 띄우면 useNativeCapture 등 하위 훅과 각 플레이어 컴포넌트가 개별적으로
  // showError를 호출할 필요가 없다 — micError 상태는 PlayerBar 연결 해제 감지 같은 부수
  // 로직에서 계속 참조하므로 그대로 유지한다.
  const setMicError = useCallback((msg: string | null) => {
    setMicErrorState(msg);
    if (msg) showError(msg);
  }, [showError]);
  const [sampleRate, setSampleRate] = useState<number | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [actualBufferSize, setActualBufferSize] = useState<number | null>(null);

  const wsRef          = useRef<SocketLike | null>(null);
  const nativeOffsRef  = useRef<Array<() => void>>([]);
  const nativeActiveRef = useRef(false);
  const playCaptureActiveRef = useRef(false);
  const rawCaptureRef  = useRef<NativeRawCapture | null>(null);
  const recordingActiveRef = useRef(true);
  const protectedCaptureRef = useRef<NativeRawCapture | null>(null);
  const analysisActiveRef = useRef(true);
  const isActiveRef    = useRef(false);
  const frameCountRef  = useRef(0);
  const framesRcvdRef  = useRef(0);
  // 보호 스트리밍 재생 루프의 접점 — useNativeCapture가 세션 시작 때 채우고, 아래 onmessage가
  // 엔진 준비/보호 PCM 도착 시점에 호출한다(types.ts의 PlaybackStreamPump 참고).
  const streamPumpRef  = useRef<PlaybackStreamPump | null>(null);
  const streamListenersRef = useRef<Set<CaptureStreamListener>>(new Set());
  const emitStreamEvent = useCallback((ev: CaptureStreamEvent) => {
    streamListenersRef.current.forEach((fn) => fn(ev));
  }, []);
  const subscribeCaptureStream = useCallback((fn: CaptureStreamListener) => {
    streamListenersRef.current.add(fn);
    return () => { streamListenersRef.current.delete(fn); };
  }, []);

  const isRecording = status === "playing";

  const cleanup = useCallback(() => {
    isActiveRef.current = false;
    streamPumpRef.current = null;

    nativeOffsRef.current.forEach((off) => off());
    nativeOffsRef.current = [];
    if (nativeActiveRef.current) {
      nativeActiveRef.current = false;
      window.audioCapture?.stop();
    }
    if (playCaptureActiveRef.current) {
      playCaptureActiveRef.current = false;
      window.audioPlayCapture?.stop();
    }

    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "stop" }));
      ws.close();
    }

    frameCountRef.current = 0;
    framesRcvdRef.current = 0;
    setDeviceName(null);
    setActualBufferSize(null);
  }, []);

  const stop = useCallback(() => {
    cleanup();
    onStatusChange("idle");
  }, [cleanup, onStatusChange]);

  const openAnalysisSocket = useCallback((actualRate: number, samplesPerCh: number): SocketLike => {
    const ws      = createAnalysisSocket();
    wsRef.current = ws;

    protectedCaptureRef.current = { channels: CHANNELS, sampleRate: actualRate, frames: [] };

    ws.onopen = () => {
      ws.send(buildInitMessage(inputParams, { sampleRate: actualRate, samplesPerCh }));
    };

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        const decoded = decodeProcessedPcmMessage(e.data);
        if (decoded) {
          const buf = protectedCaptureRef.current;
          if (buf) {
            // 보호 감쇠 PCM은 엔진이 준비된 뒤부터만 나온다 — 워밍업 동안 재생된 앞구간이
            // 통째로 비어 있다. frameIndex는 이제 재생 위치와 1:1이므로, 첫 프레임이 0이
            // 아니면 그만큼을 무음으로 메워 frames 배열의 인덱스가 곧 재생 위치가 되게 한다.
            // 이래야 (a) 뒤늦게 열린 비교 패널의 백필과 (b) 내보낸 Protected WAV가 원본/녹음
            // WAV와 같은 시간축에 놓인다 — 예전엔 둘 다 앞구간이 없는 채로 0부터 시작해
            // 원본보다 앞서 그려졌다.
            if (buf.frames.length === 0 && decoded.frameIndex > 0) {
              const silentFrame = new Int16Array(decoded.processed.length);
              for (let i = 0; i < decoded.frameIndex; i++) {
                buf.frames.push(silentFrame.slice().buffer);
              }
            }
            buf.frames.push(decoded.processed.slice().buffer);
          }
          // 보호 스트리밍 재생: 이 PCM이 곧 스피커로 나갈 신호다. 프레임 순서가 곧 재생
          // 순서라 여기서 바로(그리고 이 순서 그대로) 헬퍼에 넘긴다.
          streamPumpRef.current?.pushProtected(decoded.processed);
          emitStreamEvent({
            type: "protected",
            frameIndex: decoded.frameIndex,
            input: decoded.input,
            processed: decoded.processed,
            sampleRate: buf?.sampleRate ?? actualRate,
          });
        }
        return;
      }
      if (typeof e.data !== "string") return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg: Record<string, any> = JSON.parse(e.data);

      if (msg.type === "ready") {
        // 계측: 엔진(WASM) 로드가 끝나기 전에 흘러간 재생 구간의 크기. 그동안 도착한 프레임은
        // 분석할 세션이 없어 버려지므로, 이 값이 곧 "측정 결과가 비어 있는 앞구간"의 길이다.
        // 플랫폼 비교용 — Windows 패키지 빌드에서는 IRON_REMOTE_DEBUG_PORT를 띄우고 CDP로
        // 붙으면 이 줄을 볼 수 있다. 단 배포 빌드는 DevTools/원격 디버깅이 차단돼 있어
        // `npm run build:tauri -- --windows --devtools` 로 뽑은 측정용 빌드여야 한다
        // (src-tauri/src/main.rs의 configure_devtools_access).
        const dropped = typeof msg.warmupDroppedFrames === "number" ? msg.warmupDroppedFrames : 0;
        console.info(
          `[engine] warm-up dropped ${dropped} frame(s) = ` +
          `${((dropped * samplesPerCh) / actualRate * 1000).toFixed(1)}ms of playback ` +
          `(samplesPerCh=${samplesPerCh}, sampleRate=${actualRate})`,
        );
        isActiveRef.current = true;
        analysisActiveRef.current = true;
        frameCountRef.current = 0;
        framesRcvdRef.current = 0;
        onStatusChange("playing");
        onStreamStart();
        // 보호 스트리밍 재생의 출발점 — 여기서 프리필을 밀어 넣어야 헬퍼가 재생을 시작한다.
        // 반드시 위 카운터 리셋 뒤에 불러야 한다(produceFrames가 frameCountRef를 올린다).
        // 엔진이 준비된 뒤에야 프레임을 만들기 때문에, 이 모드에는 워밍업 드롭 구간이 없다.
        streamPumpRef.current?.onEngineReady();

      } else if (msg.type === "frame") {
        framesRcvdRef.current++;
        // ③ WASM 엔진 — 소요 시간은 엔진이 프레임마다 이미 재서 실어 보낸다
        // (engine/utils.ts의 createAnalysisFrame). 여기서는 그 값을 수집기에 넘기기만 한다.
        recordPerfSample("wasm_engine", msg.processingMs as number);
        const frame: AnalysisFrame = {
          time:        msg.time        as number,
          temperature: msg.temperature as number,
          excursion:   msg.excursion   as number,
        };
        onFrameReceived(frame);

      } else if (msg.type === "error") {
        setMicError(msg.message as string);
        cleanup();
        onStatusChange("error");
      }
    };

    ws.onerror = () => {
      setMicError("An error occurred connecting to the analysis engine.");
      cleanup();
      onStatusChange("error");
    };

    ws.onclose = () => {
      if (isActiveRef.current) {
        cleanup();
        onStatusChange("idle");
      }
    };

    return ws;
  }, [inputParams, onStatusChange, onStreamStart, onFrameReceived, cleanup, emitStreamEvent, setMicError]);

  const { start: startNativeCapture } = useNativeCapture({
    nativeOffsRef, nativeActiveRef, playCaptureActiveRef, rawCaptureRef, recordingActiveRef, analysisActiveRef,
    isActiveRef, frameCountRef, streamPumpRef,
    onStatusChange, setMicError, setSampleRate, setDeviceName,
    setActualBufferSize, openAnalysisSocket, cleanup, emitStreamEvent,
  });

  const start = useCallback(async (options?: {
    playbackPcm?: Float32Array;
    onPlaybackEnded?: () => void;
  }) => {
    setMicError(null);

    try {
      const reqSampleRate = Number(calibration.sampleRate) || SAMPLE_RATE;
      const reqBufferSize = Number(calibration.bufferSize) || SAMPLES_PER_CH;

      await startNativeCapture({
        sampleRate:       reqSampleRate,
        bufferSize:       reqBufferSize,
        channels:         calibration.channels,
        captureDeviceUID: calibration.captureDeviceUID ?? "",
        playback: options?.playbackPcm
          ? (() => {
              const outputChannel = Number(calibration.outputChannel) || 0;
              return {
                pcm: options.playbackPcm,
                onEnded: options.onPlaybackEnded ?? (() => {}),
                outputChannel,
                // R용 셀렉터 UI는 두지 않는다(Output Channel 필드 자체가 UX상 의도적으로 없음) —
                // 인접 채널(L+1)로 고정 배관. 장치에 그 채널이 없으면 네이티브 헬퍼가 조용히 모노로 폴백한다.
                outputChannelR: outputChannel + 1,
                mode: playbackMode,
              };
            })()
          : undefined,
      });

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMicError(msg);
      cleanup();
    }
  }, [calibration, playbackMode, startNativeCapture, cleanup, setMicError]);

  const getRecordedBlob = useCallback(
    (): Blob | null => blobFromCapture(rawCaptureRef.current),
    [],
  );

  const getProtectedBlob = useCallback(
    (): Blob | null => blobFromCapture(protectedCaptureRef.current),
    [],
  );

  // getRecordedBlob()과 달리 복사가 없다 — rawCaptureRef.frames를 그대로 참조로 돌려준다.
  // 채널 목록 확인과 신규 선택 채널의 초기 백필처럼 세션이 길어져도 호출 비용이 늘면 안 되는 읽기 경로용.
  const getCaptureSnapshot = useCallback((): CaptureSnapshot | null => {
    const raw = rawCaptureRef.current;
    if (!raw || raw.frames.length === 0) return null;
    const samplesPerFrame = raw.frames[0].byteLength / (raw.channels * BYTES_PER_SAMPLE);
    return {
      channels: raw.channels,
      sampleRate: raw.sampleRate,
      frames: raw.frames,
      samplesPerFrame,
      totalFrames: raw.frames.length * samplesPerFrame,
    };
  }, []);

  const hasProtectedRecording =
    !isRecording && (protectedCaptureRef.current?.frames.length ?? 0) > 0;

  const sendMessage = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const pauseRecording = useCallback(() => {
    recordingActiveRef.current = false;
    analysisActiveRef.current = false;
    if (playCaptureActiveRef.current) window.audioPlayCapture?.control("pause");
  }, []);
  const resumeRecording = useCallback(() => {
    recordingActiveRef.current = true;
    analysisActiveRef.current = true;
    if (playCaptureActiveRef.current) window.audioPlayCapture?.control("resume");
  }, []);

  useEffect(() => () => { cleanup(); }, [cleanup]);

  return {
    start, stop, cleanup, isRecording,
    micError, sampleRate, deviceName, actualBufferSize,
    getRecordedBlob, getCaptureSnapshot, sendMessage, pauseRecording, resumeRecording,
    getProtectedBlob, hasProtectedRecording,
    subscribeCaptureStream,
    frameCountRef, framesRcvdRef,
  };
}
