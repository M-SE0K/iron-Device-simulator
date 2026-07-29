"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnalysisFrame } from "@/features/audio/types";
import { perf } from "@/features/audio/lib/perf/collector";
import { e2e } from "@/features/audio/lib/perf-e2e/collector";
import { createAnalysisSocket, type SocketLike } from "@/features/audio/lib/engine/protocol/local-socket";
import { useCalibration } from "@/features/audio/components/calibration/CalibrationContext";
import { useErrorPopup } from "@/shared/components/error-popup/ErrorPopupContext";
import { pcmFramesToWavBlob } from "@/features/audio/lib/codec/wav-encoder";
import { CHANNELS, SAMPLE_RATE, SAMPLES_PER_CH, BYTES_PER_SAMPLE } from "@/features/audio/lib/engine/core";
import { decodeProcessedPcmMessage } from "@/features/audio/lib/engine/protocol/analysis";
import { useNativeCapture, type NativeRawCapture } from "./useNativeCapture";
import { useWebAudioWorkletCapture } from "./useWebAudioWorkletCapture";
import { buildInitMessage } from "./build-init-message";
import type { CaptureSnapshot, CaptureStreamEvent, CaptureStreamListener, UseCaptureSessionDeps } from "./types";

export type {
  CaptureSnapshot,
  CaptureStreamEvent,
  CaptureStreamListener,
  UseCaptureSessionDeps,
} from "./types";

export function useCaptureSession(deps: UseCaptureSessionDeps) {
  const {
    status, onStatusChange, onFrameReceived, onStreamStart, inputParams,
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
  const [actualLatency, setActualLatency] = useState<number | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [actualBufferSize, setActualBufferSize] = useState<number | null>(null);

  const wsRef          = useRef<SocketLike | null>(null);
  const audioCtxRef    = useRef<AudioContext | null>(null);
  const streamRef      = useRef<MediaStream | null>(null);
  const workletRef     = useRef<AudioWorkletNode | null>(null);
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
    perf.endSession();
    e2e.endSession();

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

    workletRef.current?.port.close();
    workletRef.current?.disconnect();
    workletRef.current = null;

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    audioCtxRef.current?.close();
    audioCtxRef.current = null;

    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "stop" }));
      ws.close();
    }

    frameCountRef.current = 0;
    framesRcvdRef.current = 0;
    setActualLatency(null);
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
          if (buf) buf.frames.push(decoded.processed.slice().buffer);
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
      const recvAt = performance.now();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg: Record<string, any> = JSON.parse(e.data);

      if (msg.type === "ready") {
        isActiveRef.current = true;
        analysisActiveRef.current = true;
        frameCountRef.current = 0;
        framesRcvdRef.current = 0;
        onStatusChange("playing");
        onStreamStart();

      } else if (msg.type === "frame") {
        framesRcvdRef.current++;
        const frame: AnalysisFrame = {
          time:        msg.time        as number,
          temperature: msg.temperature as number,
          excursion:   msg.excursion   as number,
        };
        perf.recordFrame(frame.time, msg.processingMs as number, performance.now() - recvAt);
        e2e.sample("N8", performance.now() - recvAt);
        if (typeof msg.engineExecMs === "number" && typeof msg.processingMs === "number") {
          e2e.sample("N5", msg.engineExecMs);
          e2e.sample("N6", Math.max(0, msg.processingMs - msg.engineExecMs));
        }
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
    isActiveRef, frameCountRef,
    onStatusChange, setMicError, setSampleRate, setDeviceName,
    setActualBufferSize, openAnalysisSocket, cleanup, emitStreamEvent,
  });
  const { start: startWebCapture } = useWebAudioWorkletCapture({
    audioCtxRef, streamRef, workletRef, rawCaptureRef, recordingActiveRef, analysisActiveRef,
    isActiveRef, frameCountRef,
    setSampleRate, setDeviceName, setActualBufferSize, setActualLatency,
    openAnalysisSocket, emitStreamEvent,
  });

  const start = useCallback(async (options?: {
    playbackPcm?: Float32Array;
    onPlaybackEnded?: () => void;
  }) => {
    setMicError(null);

    try {
      const reqSampleRate = Number(calibration.sampleRate) || SAMPLE_RATE;
      const reqBufferSize = Number(calibration.bufferSize) || SAMPLES_PER_CH;

      if (typeof window !== "undefined" && window.audioCapture) {
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
                };
              })()
            : undefined,
        });
        return;
      }

      await startWebCapture({
        sampleRate:       reqSampleRate,
        bufferSize:       reqBufferSize,
        channels:         calibration.channels,
        inputDeviceId:    calibration.inputDeviceId?.trim() || "",
        inputDeviceLabel: calibration.inputDeviceLabel,
      });

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Permission") || msg.includes("NotAllowed")) {
        setMicError("Microphone permission was denied. Please allow it in your browser settings.");
      } else {
        setMicError(msg);
      }
      cleanup();
    }
  }, [calibration, startNativeCapture, startWebCapture, cleanup, setMicError]);

  const getRecordedBlob = useCallback((): Blob | null => {
    const raw = rawCaptureRef.current;
    if (!raw || raw.frames.length === 0) return null;
    return pcmFramesToWavBlob(raw.frames, raw.sampleRate, raw.channels);
  }, []);

  const getProtectedBlob = useCallback((): Blob | null => {
    const buf = protectedCaptureRef.current;
    if (!buf || buf.frames.length === 0) return null;
    return pcmFramesToWavBlob(buf.frames, buf.sampleRate, buf.channels);
  }, []);

  // getRecordedBlob()과 달리 복사가 없다 — rawCaptureRef.frames를 그대로 참조로 돌려준다.
  // 채널 뷰 백필/온디맨드 확대처럼 세션이 길어져도 호출 비용이 늘면 안 되는 읽기 경로용.
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
    micError, sampleRate, deviceName, actualBufferSize, actualLatency,
    getRecordedBlob, getCaptureSnapshot, sendMessage, pauseRecording, resumeRecording,
    getProtectedBlob, hasProtectedRecording,
    subscribeCaptureStream,
    frameCountRef, framesRcvdRef,
  };
}
