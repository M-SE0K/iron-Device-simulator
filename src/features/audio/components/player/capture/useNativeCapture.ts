"use client";

import { useCallback, type MutableRefObject } from "react";
import type { AppStatus } from "@/features/audio/types";
import { perf } from "@/features/audio/lib/perf/collector";
import { e2e } from "@/features/audio/lib/perf-e2e/collector";
import type { SocketLike } from "@/features/audio/lib/engine/protocol/local-socket";
import { clampCaptureChannels, CHANNELS } from "@/features/audio/lib/engine/core";
import { encodeToInt16 } from "@/features/audio/lib/engine/utils";
import { humanizeIpcError } from "@/shared/lib/ipc-error";
import type { CaptureStreamEvent } from "./useCaptureSession";
import { createNativeFrameReframer } from "./reframeNativeChunk";

// buf(분석 엔진의 In/Out PCM)에 넣을 "음원 신호" 프레임을 만든다 — v_sensing/i_sensing이
// 이미 실측 V/I를 따로 전달하므로 buf는 더 이상 V/I를 중복으로 들고 있지 않는다. 재생 중인
// 파일이 있으면(Electron 파일 모드) 그 오디오를 캡처 프레임 위치에 맞춰 슬라이스해 쓰고,
// 없으면(mic 모드) 무음을 채운다.
function buildAudioBufFrame(
  playbackPcm: Float32Array | null,
  frameIndex: number,
  samplesPerCh: number,
): Int16Array {
  if (!playbackPcm) return new Int16Array(samplesPerCh * CHANNELS);
  const start = frameIndex * samplesPerCh;
  const mono = new Float32Array(samplesPerCh);
  const avail = Math.max(0, Math.min(samplesPerCh, playbackPcm.length - start));
  if (avail > 0) mono.set(playbackPcm.subarray(start, start + avail));
  return encodeToInt16(mono, mono); // mono를 ch0=ch1로 복제해 인터리브 2ch로 만든다
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
    pcm: Float32Array;
    onEnded: () => void;
    outputChannel?: number;
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
    const e2eActive = e2e.isEnabled();
    const baseOpts = {
      sampleRate: params.sampleRate,
      bufferSize: params.bufferSize,
      channels:   captureChannels,
      deviceUID:  params.captureDeviceUID?.trim() || undefined,
      // 켜져 있으면 main 프로세스가 stdout 청크마다 별도 채널로 Date.now() 타임스탬프를 추가로
      // 보낸다 — N1(네이티브 IPC 릴레이 지연) 측정용. 꺼져 있으면(기본) 추가 IPC 없음.
      e2e: e2eActive,
    };

    let res;
    if (playback) {
      const playCapture = window.audioPlayCapture;
      if (!playCapture) throw new Error("File playback (play-capture) bridge is unavailable.");
      const refWriteId = await uploadPlaybackRef(playCapture, playback.pcm);
      res = await playCapture.start({ ...baseOpts, refWriteId, outputChannel: playback.outputChannel });
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
    setSampleRate(actualRate);
    setActualBufferSize(res.actual?.bufferSize ?? null);
    setDeviceName(res.device || null);

    const ws = openAnalysisSocket(actualRate, wireSamplesPerCh);

    rawCaptureRef.current = { channels: captureChannels, sampleRate: actualRate, frames: [] };
    recordingActiveRef.current = true;
    emitStreamEvent({ type: "reset", channels: captureChannels, sampleRate: actualRate });

    perf.startSession({
      mode: "native", sampleRate: actualRate, samplesPerCh: wireSamplesPerCh,
      channels: captureChannels, deviceName: res.device || null,
    });
    e2e.startSession({
      mode: "native", sampleRate: actualRate, samplesPerCh: wireSamplesPerCh,
      channels: captureChannels, deviceName: res.device || null,
      engine: process.env.USE_WORKER_ENGINE === "0" ? "main-thread" : "worker",
    });

    let encStartAt = 0;
    let emittedFrames = 0;
    const reframe = createNativeFrameReframer(
      captureChannels,
      wireSamplesPerCh,
      (frame) => {
        if (!analysisActiveRef.current) return;
        perf.markFrameSent(encStartAt > 0 ? performance.now() - encStartAt : null);
        const audioBuf = buildAudioBufFrame(playback?.pcm ?? null, emittedFrames++, wireSamplesPerCh);
        ws.send(concatFrames(audioBuf, frame));
        ++frameCountRef.current;
      },
      (rawFrame) => {
        if (!recordingActiveRef.current) return;
        const copy = (rawFrame.buffer as ArrayBuffer).slice(0);
        rawCaptureRef.current?.frames.push(copy);
        emitStreamEvent({ type: "chunk", chunk: copy, channels: captureChannels, sampleRate: actualRate });
      },
    );

    const bridge = playback ? window.audioPlayCapture! : window.audioCapture!;
    const offData = bridge.onData((chunk) => {
      if (!isActiveRef.current || ws.readyState !== WebSocket.OPEN) return;
      perf.markChunkArrival();
      encStartAt = performance.now();
      e2e.time("N2", () => reframe(chunk));
    });
    // N1(네이티브 IPC 릴레이) — main 프로세스가 stdout 청크를 받은 시각(Date.now(), baseOpts.e2e로
    // 요청했을 때만 옴)과 이 렌더러 콜백이 실행된 시각의 차이. 프로세스 경계라 performance.now()는
    // 서로 다른 기준시각(process 시작 시각)을 쓰므로 비교 불가 — 반드시 Date.now()(벽시계)로 잰다.
    const offMark = e2eActive && bridge.onE2EMark
      ? bridge.onE2EMark((info) => {
          if (!isActiveRef.current) return;
          e2e.sample("N1", Date.now() - info.sentAt);
        })
      : undefined;
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
    nativeOffsRef.current = offMark ? [offData, offEnded, offMark] : [offData, offEnded];
  }, [
    nativeOffsRef, nativeActiveRef, playCaptureActiveRef, rawCaptureRef, recordingActiveRef, analysisActiveRef,
    isActiveRef, frameCountRef,
    onStatusChange, setMicError, setSampleRate, setDeviceName,
    setActualBufferSize, openAnalysisSocket, cleanup, emitStreamEvent,
  ]);

  return { start };
}
