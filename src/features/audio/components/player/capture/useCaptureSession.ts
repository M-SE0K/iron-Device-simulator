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
import type { SpeakerFault } from "@/features/audio/types";
import type {
  CaptureSnapshot, CaptureStreamEvent, CaptureStreamListener, PlaybackStreamPump, UseCaptureSessionDeps,
} from "./types";

/* 경고 해제까지 필요한 연속 정상 프레임 수 — 기본 설정(480 smp/48 kHz)에서 약 100 ms. */
const FAULT_CLEAR_FRAMES = 10;

function blobFromCapture(store: PcmFrameStore | null): Blob | null {
  if (!store || store.frameCount === 0) return null;
  return pcmFramesToWavBlob(store.byteChunks(), store.sampleRate, store.channels);
}

export function useCaptureSession(deps: UseCaptureSessionDeps) {
  const {
    onStatusChange, onFrameReceived, onStreamStart, onSpeakerFaultChange, inputParams, playbackMode = "protected",
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
  /* 현재 스피커 이상 상태(open/short/정상). 프레임 단위로 갱신되며 두 가지를 건다 —
   * ① 차트 오버레이 상태 통지(onSpeakerFaultChange), ② open 동안 캡처 원본 ch1(I)
   * 마스킹(useNativeCapture). 상태가 "바뀔 때만" 통지하므로 프레임마다 리렌더되지 않는다. */
  const speakerFaultRef = useRef<SpeakerFault | null>(null);
  /* 해제 디바운스 — 임계 바로 아래에서 진동하면 배지가 100 Hz 로 깜빡이므로, 정상 프레임이
   * 연속으로 이만큼 들어와야 경고를 내린다(기본 설정에서 10프레임 ≈ 100 ms). */
  const faultClearStreakRef = useRef(0);
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
    speakerFaultRef.current = null;
    faultClearStreakRef.current = 0;

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
      const fault = msg.speakerFault ?? null;
      if (fault !== null) {
        faultClearStreakRef.current = 0;
        if (fault !== speakerFaultRef.current) {
          speakerFaultRef.current = fault;
          onSpeakerFaultChange?.(fault);
        }
      } else if (speakerFaultRef.current !== null && ++faultClearStreakRef.current >= FAULT_CLEAR_FRAMES) {
        faultClearStreakRef.current = 0;
        speakerFaultRef.current = null;
        onSpeakerFaultChange?.(null);
      }
      onFrameReceived({
        time:        msg.time,
        temperature: msg.temperature,
        excursion:   msg.excursion,
        speakerFault: fault,
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
  }, [inputParams, onStatusChange, onStreamStart, onFrameReceived, onSpeakerFaultChange, cleanup, emitStreamEvent, setMicError]);

  const { start: startNativeCapture } = useNativeCapture({
    nativeOffsRef, nativeActiveRef, playCaptureActiveRef, rawCaptureRef, recordingActiveRef, analysisActiveRef,
    isActiveRef, streamPumpRef, speakerFaultRef,
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
