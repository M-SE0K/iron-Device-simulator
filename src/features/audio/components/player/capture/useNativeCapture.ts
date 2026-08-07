"use client";

import { useCallback, type MutableRefObject } from "react";
import type { AppStatus } from "@/features/audio/types";
import type { SocketLike } from "@/features/audio/lib/engine/protocol/socket-types";
import { clampCaptureChannels, CHANNELS } from "@/features/audio/lib/engine/core";
import { encodeToInt16 } from "@/features/audio/lib/engine/utils";
import { humanizeIpcError } from "@/shared/lib/ipc-error";
import type { CaptureStreamEvent } from "./types";
import { createNativeFrameReframer } from "./reframeNativeChunk";

// playback PCM이 있으면 파일 오디오를 프레임 위치에 맞춰 쓰고, 없으면 무음을 채운다.
function buildAudioBufFrame(
  playbackPcmInterleaved: Float32Array | null,
  frameIndex: number,
  samplesPerCh: number,
): Int16Array {
  if (!playbackPcmInterleaved) return new Int16Array(samplesPerCh * CHANNELS);
  const startFrame = frameIndex * samplesPerCh;
  const totalFrames = playbackPcmInterleaved.length / 2;
  const left = new Float32Array(samplesPerCh);
  const right = new Float32Array(samplesPerCh);
  const avail = Math.max(0, Math.min(samplesPerCh, totalFrames - startFrame));
  for (let i = 0; i < avail; i++) {
    const srcIdx = (startFrame + i) * 2;
    left[i]  = playbackPcmInterleaved[srcIdx];
    right[i] = playbackPcmInterleaved[srcIdx + 1];
  }
  return encodeToInt16(left, right);
}

function concatFrames(a: Int16Array, b: Int16Array): ArrayBuffer {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), 0);
  out.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), a.byteLength);
  return out.buffer;
}

export interface NativeCaptureParams {
  sampleRate: number;
  bufferSize: number;
  channels: string;
  captureDeviceUID: string;
  playback?: {
    pcm: Float32Array; // 인터리브 스테레오 [L0,R0,L1,R1,...]
    onEnded: () => void;
    outputChannel?: number;
    outputChannelR?: number; // 있으면 스테레오 재생 시도(범위 밖/L과 중복이면 헬퍼가 조용히 모노 폴백)
  };
}

export interface NativeRawCapture {
  channels: number;
  sampleRate: number;
  frames: ArrayBuffer[];
}

export interface NativeCaptureDeps {
  nativeOffsRef: MutableRefObject<Array<() => void>>;
  nativeActiveRef: MutableRefObject<boolean>;
  playCaptureActiveRef: MutableRefObject<boolean>;
  rawCaptureRef: MutableRefObject<NativeRawCapture | null>;
  recordingActiveRef: MutableRefObject<boolean>;
  analysisActiveRef: MutableRefObject<boolean>;
  isActiveRef: MutableRefObject<boolean>;
  frameCountRef: MutableRefObject<number>;
  onStatusChange: (s: AppStatus) => void;
  setMicError: (msg: string | null) => void;
  setSampleRate: (v: number | null) => void;
  setDeviceName: (v: string | null) => void;
  setActualBufferSize: (v: number | null) => void;
  openAnalysisSocket: (actualRate: number, samplesPerCh: number) => SocketLike;
  cleanup: () => void;
  emitStreamEvent: (ev: CaptureStreamEvent) => void;
}

const REF_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

async function uploadPlaybackRef(
  bridge: NonNullable<Window["audioPlayCapture"]>,
  pcm: Float32Array,
): Promise<string> {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const started = await bridge.startWrite({ totalBytes: bytes.byteLength });
  if (!started.success || !started.writeId) {
    throw new Error(humanizeIpcError(started.error, "Failed to start the playback file transfer."));
  }
  const { writeId } = started;
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += REF_UPLOAD_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(offset + REF_UPLOAD_CHUNK_BYTES, bytes.byteLength));
      const res = await bridge.writeChunk({ writeId, chunk });
      if (!res.success) throw new Error(humanizeIpcError(res.error, "Failed to transfer the playback file."));
    }
    const finalized = await bridge.finalizeWrite({ writeId });
    if (!finalized.success) throw new Error(humanizeIpcError(finalized.error, "Failed to finish the playback file transfer."));
  } catch (err) {
    bridge.cancelWrite({ writeId });
    throw err;
  }
  return writeId;
}

export function useNativeCapture(deps: NativeCaptureDeps) {
  const {
    nativeOffsRef, nativeActiveRef, playCaptureActiveRef, rawCaptureRef, recordingActiveRef, analysisActiveRef,
    isActiveRef, frameCountRef,
    onStatusChange, setMicError, setSampleRate, setDeviceName,
    setActualBufferSize, openAnalysisSocket, cleanup, emitStreamEvent,
  } = deps;

  const start = useCallback(async (params: NativeCaptureParams) => {
    const { playback } = params;

    const captureChannels = clampCaptureChannels(params.channels);
    const baseOpts = {
      sampleRate: params.sampleRate,
      bufferSize: params.bufferSize,
      channels:   captureChannels,
      deviceUID:  params.captureDeviceUID?.trim() || undefined,
    };

    let res;
    if (playback) {
      const playCapture = window.audioPlayCapture;
      if (!playCapture) throw new Error("File playback (play-capture) bridge is unavailable.");
      const refWriteId = await uploadPlaybackRef(playCapture, playback.pcm);
      res = await playCapture.start({
        ...baseOpts, refWriteId,
        refChannels: 2,
        outputChannel: playback.outputChannel,
        outputChannelR: playback.outputChannelR,
      });
      if (!res.success && res.error?.includes("device-has-no-output")) {
        throw new Error(
          "The selected Capture Device has no output channels, so file playback isn't possible. " +
          "Choose a combined input/output device (e.g. MCHStreamer) as the Capture Device."
        );
      }
    } else {
      const nativeCapture = window.audioCapture;
      if (!nativeCapture) throw new Error("Native capture bridge is unavailable.");
      res = await nativeCapture.start(baseOpts);
    }
    if (!res.success) {
      throw new Error(humanizeIpcError(res.error, "Failed to start native capture."));
    }

    const actualRate = res.actual?.sampleRate ?? params.sampleRate;
    if (playback && Math.abs(actualRate - params.sampleRate) >= 1) {
      window.audioPlayCapture?.stop();
      throw new Error(
        `The device couldn't apply the requested sample rate (${params.sampleRate} Hz) — actual ${actualRate} Hz. ` +
        "Choose a sample rate the device supports in Calibration."
      );
    }
    if (playback) playCaptureActiveRef.current = true;
    else nativeActiveRef.current = true;
    const wireSamplesPerCh = res.actual?.bufferSize ?? params.bufferSize;
    // 헬퍼가 실제로 연 채널 수 — 요청값(captureChannels)과 다를 수 있다(드라이버가 요청한
    // 채널 수를 다 못 받아주는 경우 등). 헬퍼는 응답 헤더에 이 값을 "channels"로 정직하게
    // 돌려주는데(main.cpp/mac.swift 둘 다), 지금까지 이 필드를 아무도 읽지 않고 요청값을
    // 그대로 wire 프레이밍(reframeNativeChunk)에 썼다 — 실제로 열린 채널 수가 요청과 어긋나면
    // 인터리브 바이트 계산 전체가 틀어져 채널 뷰/저장된 WAV가 전부 0(또는 뒤섞인 값)으로
    // 보이는 원인이 된다. 항상 헬퍼가 보고한 실측값을 우선한다.
    const actualChannels = res.channels ?? captureChannels;
    setSampleRate(actualRate);
    setActualBufferSize(res.actual?.bufferSize ?? null);
    setDeviceName(res.device || null);

    const ws = openAnalysisSocket(actualRate, wireSamplesPerCh);

    rawCaptureRef.current = { channels: actualChannels, sampleRate: actualRate, frames: [] };
    recordingActiveRef.current = true;
    emitStreamEvent({ type: "reset", channels: actualChannels, sampleRate: actualRate });

    let emittedFrames = 0;
    const reframe = createNativeFrameReframer(
      actualChannels,
      wireSamplesPerCh,
      (frame) => {
        if (!analysisActiveRef.current) return;
        // ⚠️ emittedFrames(재생 PCM에서 몇 번째 프레임을 실을지)와 소켓 내부의 frameCount
        // (그 결과가 차트 x축 어디에 놓일지)는 **반드시 같은 수를 세야 한다**. 소켓은
        // OPEN이 아닌 동안 send()를 조용히 무시하는데(local-socket.ts / worker-socket.ts),
        // 그 사이 여기서만 번호를 올리면 이후 모든 프레임에서 "재생 위치 N+D의 오디오가
        // x=N에 그려지는" 어긋남이 남는다 — Protected 파형이 Input(원본)보다 D프레임만큼
        // 앞당겨져 보이는 증상이 정확히 이것이다. 소켓과 같은 조건으로 먼저 걸러
        // 두 카운터가 갈라질 여지 자체를 없앤다.
        if (ws.readyState !== WebSocket.OPEN) return;
        const audioBuf = buildAudioBufFrame(playback?.pcm ?? null, emittedFrames++, wireSamplesPerCh);
        ws.send(concatFrames(audioBuf, frame));
        ++frameCountRef.current;
      },
      (rawFrame) => {
        if (!recordingActiveRef.current) return;
        const copy = (rawFrame.buffer as ArrayBuffer).slice(0);
        rawCaptureRef.current?.frames.push(copy);
        emitStreamEvent({ type: "chunk", chunk: copy, channels: actualChannels, sampleRate: actualRate });
      },
    );

    const bridge = playback ? window.audioPlayCapture! : window.audioCapture!;
    const offData = bridge.onData((chunk) => {
      // 엔진 준비("ready") 전에 도착한 청크도 원본 녹음/채널 뷰에는 반드시 들어가야 한다.
      // 예전엔 여기서 isActiveRef(= "ready"를 받아야 true)로 청크를 통째로 걸러냈다 — WASM
      // 로드가 끝나기 전까지의 세션 앞부분이 rawCaptureRef에 아예 안 쌓여서 저장된 WAV,
      // 채널 차트, peak/rms 배지에서 그 구간이 통째로 사라졌다. 하필 IOProc 기동 직후의
      // 과도 구간이 거기에 있어(실측: 정상 구간의 약 20배 진폭) 채널 피크가 크게 어긋났고,
      // 재생은 그 사이에도 흘러가므로 분석에 실리는 audioBuf 프레임 번호(emittedFrames)와
      // 실제 재생 위치도 버린 만큼 어긋나 있었다.
      // 분석 프레임을 실제로 보낼지 말지는 reframer의 analysisActiveRef 게이트가 계속 맡는다.
      if (ws.readyState === WebSocket.CLOSED) return;
      reframe(chunk);
    });
    const offEnded = bridge.onEnded((info) => {
      if (!isActiveRef.current) return;
      if (playback && info.code === 0) {
        playback.onEnded();
        return;
      }
      if (info.code === 3) {
        setMicError("Lost connection to the Capture Device (e.g. USB disconnect). Reconnect the device and restart.");
        cleanup();
        onStatusChange("error");
        return;
      }
      setMicError("Native capture ended unexpectedly.");
      cleanup();
      onStatusChange("error");
    });
    nativeOffsRef.current = [offData, offEnded];
  }, [
    nativeOffsRef, nativeActiveRef, playCaptureActiveRef, rawCaptureRef, recordingActiveRef, analysisActiveRef,
    isActiveRef, frameCountRef,
    onStatusChange, setMicError, setSampleRate, setDeviceName,
    setActualBufferSize, openAnalysisSocket, cleanup, emitStreamEvent,
  ]);

  return { start };
}
