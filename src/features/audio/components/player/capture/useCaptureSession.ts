"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useCalibration } from "@/features/audio/components/calibration/CalibrationContext";
import { useErrorPopup } from "@/shared/components/error-popup/ErrorPopupContext";
import { recordPerfSample } from "@/shared/lib/iron-perf";
import { pcmFramesToWavBlob } from "@/features/audio/lib/codec/wav-encoder";
import { CHANNELS, SAMPLE_RATE, SAMPLES_PER_CH } from "@/features/audio/lib/engine/core";
import { createEngineClient, type EngineClient } from "@/features/audio/lib/engine/protocol/engine-client";
import { PcmFrameStore } from "@/features/audio/lib/pcm-frame-store";
import { useNativeCapture } from "./useNativeCapture";
import type {
  CaptureSnapshot, CaptureStreamEvent, CaptureStreamListener, PlaybackStreamPump, UseCaptureSessionDeps,
} from "./types";

function blobFromCapture(store: PcmFrameStore | null): Blob | null {
  if (!store || store.frameCount === 0) return null;
  return pcmFramesToWavBlob(store.byteChunks(), store.sampleRate, store.channels);
}

export function useCaptureSession(deps: UseCaptureSessionDeps) {
  const {
    onStatusChange, onFrameReceived, onStreamStart, onSpeakerOpen, inputParams, playbackMode = "protected",
  } = deps;
  const { values: calibration } = useCalibration();
  const { showError } = useErrorPopup();

  const [micError, setMicErrorState] = useState<string | null>(null);
  const setMicError = useCallback((msg: string | null) => {
    setMicErrorState(msg);
    if (msg) showError(msg);
  }, [showError]);
  const clientRef      = useRef<EngineClient | null>(null);
  const nativeOffsRef  = useRef<Array<() => void>>([]);
  const nativeActiveRef = useRef(false);
  const playCaptureActiveRef = useRef(false);
  const rawCaptureRef  = useRef<PcmFrameStore | null>(null);
  const recordingActiveRef = useRef(true);
  const protectedCaptureRef = useRef<PcmFrameStore | null>(null);
  const analysisActiveRef = useRef(true);
  const isActiveRef    = useRef(false);
  /* 세션이 "스피커 open" 상태로 넘어갔는지. 한 번 서면 세션이 끝날 때까지 유지되고 두 가지를
   * 건다 — ① 차트 오버레이 상태 통지(onSpeakerOpen)를 프레임마다가 아니라 1회만, ② 캡처
   * 원본 ch1(I) 마스킹(useNativeCapture). */
  const speakerOpenRef = useRef(false);
  const streamPumpRef  = useRef<PlaybackStreamPump | null>(null);
  const streamListenersRef = useRef<Set<CaptureStreamListener>>(new Set());
  const emitStreamEvent = useCallback((ev: CaptureStreamEvent) => {
    streamListenersRef.current.forEach((fn) => fn(ev));
  }, []);
  const subscribeCaptureStream = useCallback((fn: CaptureStreamListener) => {
    streamListenersRef.current.add(fn);
    return () => { streamListenersRef.current.delete(fn); };
  }, []);

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

    const client = clientRef.current;
    clientRef.current = null;
    client?.stop();
  }, []);

  const openEngineClient = useCallback((actualRate: number, samplesPerCh: number, expectedPlaybackFrames: number): EngineClient => {
    const client = createEngineClient();
    clientRef.current = client;
    speakerOpenRef.current = false;

    protectedCaptureRef.current = new PcmFrameStore({
      channels: CHANNELS,
      sampleRate: actualRate,
      samplesPerFrame: samplesPerCh,
      expectedFrames: expectedPlaybackFrames > 0 ? expectedPlaybackFrames : undefined,
    });

    client.onProtectedPcm = ({ frameIndex, input, processed }) => {
      const buf = protectedCaptureRef.current;
      if (buf) {
        if (buf.frameCount === 0 && frameIndex > 0) {
          buf.appendSilence(frameIndex);
        }
        buf.append(processed);
      }
      streamPumpRef.current?.pushProtected(processed);
      emitStreamEvent({
        type: "protected",
        frameIndex,
        input,
        processed,
        sampleRate: buf?.sampleRate ?? actualRate,
      });
    };

    client.onReady = (dropped) => {
      console.info(
        `[engine] warm-up dropped ${dropped} frame(s) = ` +
        `${((dropped * samplesPerCh) / actualRate * 1000).toFixed(1)}ms of playback ` +
        `(samplesPerCh=${samplesPerCh}, sampleRate=${actualRate})`,
      );
      isActiveRef.current = true;
      analysisActiveRef.current = true;
      onStatusChange("playing");
      onStreamStart();
      streamPumpRef.current?.onEngineReady();
    };

    client.onFrame = (msg) => {
      recordPerfSample("wasm_engine", msg.processingMs);
      if (msg.tempOverflow && !speakerOpenRef.current) {
        speakerOpenRef.current = true;
        onSpeakerOpen?.();
      }
      onFrameReceived({
        time:        msg.time,
        temperature: msg.temperature,
        excursion:   msg.excursion,
      });
    };

    client.onError = (message) => {
      setMicError(message);
      cleanup();
      onStatusChange("error");
    };

    client.onTransportError = () => {
      setMicError("An error occurred connecting to the analysis engine.");
      cleanup();
      onStatusChange("error");
    };

    client.init({
      sampleRate: actualRate,
      bufferSize: samplesPerCh,
      ambientTemp: inputParams?.ambientTemp ?? "",
    });

    return client;
  }, [inputParams, onStatusChange, onStreamStart, onFrameReceived, onSpeakerOpen, cleanup, emitStreamEvent, setMicError]);

  const { start: startNativeCapture } = useNativeCapture({
    nativeOffsRef, nativeActiveRef, playCaptureActiveRef, rawCaptureRef, recordingActiveRef, analysisActiveRef,
    isActiveRef, streamPumpRef, speakerOpenRef,
    onStatusChange, setMicError, openEngineClient, cleanup, emitStreamEvent,
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

  const snapshotOf = (store: PcmFrameStore | null): CaptureSnapshot | null => {
    if (!store || store.frameCount === 0) return null;
    return {
      channels: store.channels,
      sampleRate: store.sampleRate,
      pcm: store,
      samplesPerFrame: store.samplesPerFrame,
      totalFrames: store.totalSamples,
    };
  };

  const getCaptureSnapshot = useCallback((): CaptureSnapshot | null => snapshotOf(rawCaptureRef.current), []);


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
    start, cleanup,
    micError,
    getRecordedBlob, getCaptureSnapshot, pauseRecording, resumeRecording,
    getProtectedBlob,
    subscribeCaptureStream,
  };
}
