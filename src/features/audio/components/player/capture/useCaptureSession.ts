"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import { perf } from "@/features/audio/lib/perf/collector";
import { createAnalysisSocket, type SocketLike } from "@/features/audio/lib/engine/protocol/local-socket";
import { useCalibration } from "@/features/audio/components/calibration/CalibrationContext";
import { pcmFramesToWavBlob } from "@/features/audio/lib/codec/wav-encoder";
import { BYTES_PER_SAMPLE, CHANNELS, SAMPLE_RATE, SAMPLES_PER_CH } from "@/features/audio/lib/engine/core";
import { decodeProcessedPcmMessage } from "@/features/audio/lib/engine/protocol/analysis";
import { useNativeCapture, type NativeRawCapture } from "./useNativeCapture";
import { useWebAudioWorkletCapture } from "./useWebAudioWorkletCapture";
import { buildInitMessage } from "../stream/buildInitMessage";

export interface CaptureRecordingExport {
  blob: Blob;
  channels: number;
  sampleRate: number;
  durationSec: number;
}

export type CaptureStreamEvent =
  | { type: "reset"; channels: number; sampleRate: number }
  | { type: "chunk"; chunk: ArrayBuffer; channels: number; sampleRate: number }
  | { type: "protected"; frameIndex: number; input: Int16Array; processed: Int16Array; sampleRate: number };
export type CaptureStreamListener = (ev: CaptureStreamEvent) => void;

export interface UseCaptureSessionDeps {
  status: AppStatus;
  onStatusChange: (s: AppStatus) => void;
  onFrameReceived: (frame: AnalysisFrame) => void;
  onStreamStart: () => void;
  onSaveRecording?: (rec: CaptureRecordingExport) => Promise<void> | void;
  inputParams: InputParameterValues | undefined;
}

export function useCaptureSession(deps: UseCaptureSessionDeps) {
  const {
    status, onStatusChange, onFrameReceived, onStreamStart,
    onSaveRecording, inputParams,
  } = deps;
  const { values: calibration } = useCalibration();

  const [micError, setMicError] = useState<string | null>(null);
  const [sampleRate, setSampleRate] = useState<number | null>(null);
  const [actualLatency, setActualLatency] = useState<number | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [actualBufferSize, setActualBufferSize] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

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
          temperature: msg.temperature as [number, number],
          excursion:   msg.excursion   as [number, number],
        };
        perf.recordFrame(frame.time, msg.processingMs as number, performance.now() - recvAt);
        onFrameReceived(frame);

      } else if (msg.type === "error") {
        setMicError(msg.message as string);
        cleanup();
        onStatusChange("error");
      }
    };

    ws.onerror = () => {
      setMicError("분석 엔진 연결 오류가 발생했습니다.");
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
  }, [inputParams, onStatusChange, onStreamStart, onFrameReceived, cleanup, emitStreamEvent]);

  const { start: startNativeCapture } = useNativeCapture({
    nativeOffsRef, nativeActiveRef, playCaptureActiveRef, rawCaptureRef, recordingActiveRef, analysisActiveRef,
    isActiveRef, frameCountRef,
    onStatusChange, setMicError, setSampleRate, setDeviceName,
    setActualBufferSize, openAnalysisSocket, cleanup, emitStreamEvent,
  });
  const { start: startWebCapture } = useWebAudioWorkletCapture({
    audioCtxRef, streamRef, workletRef, analysisActiveRef, isActiveRef, frameCountRef,
    setSampleRate, setDeviceName, setActualBufferSize, setActualLatency,
    openAnalysisSocket,
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
            ? {
                pcm: options.playbackPcm,
                onEnded: options.onPlaybackEnded ?? (() => {}),
                outputChannel: Number(calibration.outputChannel) || 0,
              }
            : undefined,
        });
        return;
      }

      await startWebCapture({
        sampleRate:       reqSampleRate,
        bufferSize:       reqBufferSize,
        inputDeviceId:    calibration.inputDeviceId?.trim() || "",
        inputDeviceLabel: calibration.inputDeviceLabel,
      });

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Permission") || msg.includes("NotAllowed")) {
        setMicError("마이크 권한이 거부되었습니다. 브라우저 설정에서 허용해주세요.");
      } else {
        setMicError(msg);
      }
      cleanup();
    }
  }, [calibration, startNativeCapture, startWebCapture, cleanup]);

  const saveRecording = useCallback(async () => {
    const raw = rawCaptureRef.current;
    if (!raw || raw.frames.length === 0 || !onSaveRecording) return;
    setSaving(true);
    try {
      const blob = pcmFramesToWavBlob(raw.frames, raw.sampleRate, raw.channels);
      const totalSampleFrames =
        raw.frames.reduce((sum, f) => sum + f.byteLength, 0) / (raw.channels * BYTES_PER_SAMPLE);
      await onSaveRecording({
        blob,
        channels:    raw.channels,
        sampleRate:  raw.sampleRate,
        durationSec: totalSampleFrames / raw.sampleRate,
      });
    } finally {
      setSaving(false);
    }
  }, [onSaveRecording]);

  const hasRecording = !isRecording && (rawCaptureRef.current?.frames.length ?? 0) > 0;
  const recordingChannels = rawCaptureRef.current?.channels ?? null;

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
    saveRecording, hasRecording, saving, recordingChannels,
    getRecordedBlob, sendMessage, pauseRecording, resumeRecording,
    getProtectedBlob, hasProtectedRecording,
    subscribeCaptureStream,
    frameCountRef, framesRcvdRef,
  };
}
