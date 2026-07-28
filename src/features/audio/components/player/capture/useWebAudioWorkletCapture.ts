"use client";

import { useCallback, type MutableRefObject } from "react";
import { createCaptureTelemetry } from "@/features/audio/lib/perf/capture-telemetry";
import type { SocketLike } from "@/features/audio/lib/engine/protocol/local-socket";
import { encodeToInt16 } from "@/features/audio/lib/engine/utils";

export interface WebCaptureParams {
  sampleRate: number;
  bufferSize: number;
  inputDeviceId: string;
  inputDeviceLabel: string;
}

export interface WebCaptureDeps {
  audioCtxRef: MutableRefObject<AudioContext | null>;
  streamRef: MutableRefObject<MediaStream | null>;
  workletRef: MutableRefObject<AudioWorkletNode | null>;
  analysisActiveRef: MutableRefObject<boolean>;
  isActiveRef: MutableRefObject<boolean>;
  frameCountRef: MutableRefObject<number>;
  setSampleRate: (v: number | null) => void;
  setDeviceName: (v: string | null) => void;
  setActualBufferSize: (v: number | null) => void;
  setActualLatency: (v: number | null) => void;
  openAnalysisSocket: (actualRate: number, samplesPerCh: number) => SocketLike;
}

export function useWebAudioWorkletCapture(deps: WebCaptureDeps) {
  const {
    audioCtxRef, streamRef, workletRef, analysisActiveRef, isActiveRef, frameCountRef,
    setSampleRate, setDeviceName, setActualBufferSize, setActualLatency,
    openAnalysisSocket,
  } = deps;

  const start = useCallback(async (params: WebCaptureParams) => {
    const latencyHint = params.bufferSize / params.sampleRate;

    const audioConstraints: MediaTrackConstraints & { latency?: ConstrainDouble } = {
      channelCount:     2,
      sampleRate:       { ideal: params.sampleRate },
      latency:          { ideal: latencyHint },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl:  false,
    };
    if (params.inputDeviceId) {
      audioConstraints.deviceId = { exact: params.inputDeviceId };
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    streamRef.current = stream;
    setDeviceName(stream.getAudioTracks()[0]?.label || params.inputDeviceLabel || null);

    const trackSettings = stream.getAudioTracks()[0]?.getSettings() as MediaTrackSettings & { latency?: number };
    setActualLatency(trackSettings?.latency ?? null);

    const ctx           = new AudioContext();
    audioCtxRef.current = ctx;
    if (ctx.state === "suspended") await ctx.resume();
    const actualRate    = ctx.sampleRate;
    setSampleRate(actualRate);

    await ctx.audioWorklet.addModule("/mic-processor.js");
    const worklet = new AudioWorkletNode(ctx, "mic-processor", {
      processorOptions: { samplesPerCh: params.bufferSize },
    });
    workletRef.current = worklet;
    setActualBufferSize(params.bufferSize);

    const source      = ctx.createMediaStreamSource(stream);
    const silentGain  = ctx.createGain();
    silentGain.gain.value = 0;
    source.connect(worklet);
    worklet.connect(silentGain);
    silentGain.connect(ctx.destination);

    const ws = openAnalysisSocket(actualRate, params.bufferSize);

    const deviceName = stream.getAudioTracks()[0]?.label || params.inputDeviceLabel || null;
    const telemetry = createCaptureTelemetry<Int16Array>({
      mode: "web", sampleRate: actualRate, samplesPerCh: params.bufferSize,
      channels: 2, deviceName,
      onEncodedFrame: (interleaved) => {
        ws.send(interleaved.buffer as ArrayBuffer);
        ++frameCountRef.current;
      },
    });

    // N1(네이티브 IPC 릴레이)은 Electron 전용이라 web 캡처 경로에는 없다.
    worklet.port.onmessage = (e: MessageEvent<{ L: Float32Array; R: Float32Array }>) => {
      if (!isActiveRef.current || ws.readyState !== WebSocket.OPEN) return;
      telemetry.markChunkArrival();
      if (!analysisActiveRef.current) return;
      const interleaved = telemetry.measureEncoding(() => encodeToInt16(e.data.L, e.data.R));
      telemetry.markEncodedFrame(interleaved);
    };
  }, [
    audioCtxRef, streamRef, workletRef, analysisActiveRef, isActiveRef, frameCountRef,
    setSampleRate, setDeviceName, setActualBufferSize, setActualLatency,
    openAnalysisSocket,
  ]);

  return { start };
}
