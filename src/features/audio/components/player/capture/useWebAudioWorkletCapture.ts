"use client";

import { useCallback, type MutableRefObject } from "react";
import { createCaptureTelemetry } from "@/features/audio/lib/perf/capture-telemetry";
import type { SocketLike } from "@/features/audio/lib/engine/protocol/local-socket";
import { encodeToInt16, interleaveChannelsToInt16 } from "@/features/audio/lib/engine/utils";
import { clampCaptureChannels } from "@/features/audio/lib/engine/core";
import type { CaptureStreamEvent } from "./types";
import type { NativeRawCapture } from "./useNativeCapture";

export interface WebCaptureParams {
  sampleRate: number;
  bufferSize: number;
  channels: string;
  inputDeviceId: string;
  inputDeviceLabel: string;
}

export interface WebCaptureDeps {
  audioCtxRef: MutableRefObject<AudioContext | null>;
  streamRef: MutableRefObject<MediaStream | null>;
  workletRef: MutableRefObject<AudioWorkletNode | null>;
  rawCaptureRef: MutableRefObject<NativeRawCapture | null>;
  recordingActiveRef: MutableRefObject<boolean>;
  analysisActiveRef: MutableRefObject<boolean>;
  isActiveRef: MutableRefObject<boolean>;
  frameCountRef: MutableRefObject<number>;
  setSampleRate: (v: number | null) => void;
  setDeviceName: (v: string | null) => void;
  setActualBufferSize: (v: number | null) => void;
  setActualLatency: (v: number | null) => void;
  openAnalysisSocket: (actualRate: number, samplesPerCh: number) => SocketLike;
  emitStreamEvent: (ev: CaptureStreamEvent) => void;
}

export function useWebAudioWorkletCapture(deps: WebCaptureDeps) {
  const {
    audioCtxRef, streamRef, workletRef, rawCaptureRef, recordingActiveRef, analysisActiveRef,
    isActiveRef, frameCountRef,
    setSampleRate, setDeviceName, setActualBufferSize, setActualLatency,
    openAnalysisSocket, emitStreamEvent,
  } = deps;

  const start = useCallback(async (params: WebCaptureParams) => {
    const latencyHint = params.bufferSize / params.sampleRate;
    const requestedChannels = clampCaptureChannels(params.channels);

    const audioConstraints: MediaTrackConstraints & { latency?: ConstrainDouble } = {
      channelCount:     { ideal: requestedChannels },
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
    // 브라우저/장치가 요청한 채널 수를 못 맞춰줄 수 있으므로 실제 협상된 값을 읽는다
    // (네이티브 경로가 res.actual로 실채널을 읽는 것과 동일한 패턴).
    const actualChannels = trackSettings?.channelCount ?? requestedChannels;

    const ctx           = new AudioContext();
    audioCtxRef.current = ctx;
    if (ctx.state === "suspended") await ctx.resume();
    const actualRate    = ctx.sampleRate;
    setSampleRate(actualRate);

    await ctx.audioWorklet.addModule("/mic-processor.js");
    const worklet = new AudioWorkletNode(ctx, "mic-processor", {
      channelCount:         actualChannels,
      channelCountMode:     "explicit",
      channelInterpretation: "discrete",
      processorOptions: { samplesPerCh: params.bufferSize, channels: actualChannels },
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

    rawCaptureRef.current = { channels: actualChannels, sampleRate: actualRate, frames: [] };
    recordingActiveRef.current = true;
    emitStreamEvent({ type: "reset", channels: actualChannels, sampleRate: actualRate });

    const deviceName = stream.getAudioTracks()[0]?.label || params.inputDeviceLabel || null;
    const telemetry = createCaptureTelemetry<Int16Array>({
      mode: "web", sampleRate: actualRate, samplesPerCh: params.bufferSize,
      channels: actualChannels, deviceName,
      onEncodedFrame: (interleaved) => {
        ws.send(interleaved.buffer as ArrayBuffer);
        ++frameCountRef.current;
      },
    });

    // N1(네이티브 IPC 릴레이)은 Electron 전용이라 web 캡처 경로에는 없다.
    worklet.port.onmessage = (e: MessageEvent<{ channels: Float32Array[] }>) => {
      if (!isActiveRef.current || ws.readyState !== WebSocket.OPEN) return;
      telemetry.markChunkArrival();
      const chans = e.data.channels;
      if (recordingActiveRef.current) {
        const raw = interleaveChannelsToInt16(chans);
        rawCaptureRef.current?.frames.push(raw.buffer as ArrayBuffer);
        emitStreamEvent({ type: "chunk", chunk: raw.buffer as ArrayBuffer, channels: actualChannels, sampleRate: actualRate });
      }
      if (!analysisActiveRef.current) return;
      const interleaved = telemetry.measureEncoding(() => encodeToInt16(chans[0], chans[1] ?? chans[0]));
      telemetry.markEncodedFrame(interleaved);
    };
  }, [
    audioCtxRef, streamRef, workletRef, rawCaptureRef, recordingActiveRef, analysisActiveRef,
    isActiveRef, frameCountRef,
    setSampleRate, setDeviceName, setActualBufferSize, setActualLatency,
    openAnalysisSocket, emitStreamEvent,
  ]);

  return { start };
}
