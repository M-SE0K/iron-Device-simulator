"use client";

import { useCallback, type MutableRefObject } from "react";
import type { AppStatus } from "@/features/audio/types";
import { perf } from "@/features/audio/lib/perf/collector";
import { e2e } from "@/features/audio/lib/perf-e2e/collector";
import type { SocketLike } from "@/features/audio/lib/engine/protocol/local-socket";
import { clampCaptureChannels } from "@/features/audio/lib/engine/core";
import type { CaptureStreamEvent } from "./useCaptureSession";
import { createNativeFrameReframer } from "./reframeNativeChunk";

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
    throw new Error(`재생 파일 전송 시작 실패: ${started.error ?? "unknown"}`);
  }
  const { writeId } = started;
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += REF_UPLOAD_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(offset + REF_UPLOAD_CHUNK_BYTES, bytes.byteLength));
      const res = await bridge.writeChunk({ writeId, chunk });
      if (!res.success) throw new Error(`재생 파일 전송 실패: ${res.error ?? "unknown"}`);
    }
    const finalized = await bridge.finalizeWrite({ writeId });
    if (!finalized.success) throw new Error(`재생 파일 전송 마무리 실패: ${finalized.error ?? "unknown"}`);
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
      if (!playCapture) throw new Error("파일 재생(play-capture) 브리지를 사용할 수 없습니다.");
      const refWriteId = await uploadPlaybackRef(playCapture, playback.pcm);
      res = await playCapture.start({ ...baseOpts, refWriteId, outputChannel: playback.outputChannel });
      if (!res.success && res.error?.includes("device-has-no-output")) {
        throw new Error(
          "선택한 캡처 장치에 출력 채널이 없어 파일 재생이 불가합니다. " +
          "입·출력 겸용 장치(예: MCHStreamer)를 Capture Device로 선택하세요."
        );
      }
    } else {
      const nativeCapture = window.audioCapture;
      if (!nativeCapture) throw new Error("네이티브 캡처 브리지를 사용할 수 없습니다.");
      res = await nativeCapture.start(baseOpts);
    }
    if (!res.success) {
      throw new Error(`네이티브 캡처 시작 실패: ${res.error ?? "unknown"}`);
    }

    const actualRate = res.actual?.sampleRate ?? params.sampleRate;
    if (playback && Math.abs(actualRate - params.sampleRate) >= 1) {
      window.audioPlayCapture?.stop();
      throw new Error(
        `장치가 요청 샘플레이트(${params.sampleRate} Hz)를 적용하지 못했습니다(실제 ${actualRate} Hz) — ` +
        "Calibration에서 장치가 지원하는 샘플레이트를 선택하세요."
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
      engine: process.env.NEXT_PUBLIC_USE_WORKER_ENGINE === "0" ? "main-thread" : "worker",
    });

    let encStartAt = 0;
    const reframe = createNativeFrameReframer(
      captureChannels,
      wireSamplesPerCh,
      (frame) => {
        if (!analysisActiveRef.current) return;
        perf.markFrameSent(encStartAt > 0 ? performance.now() - encStartAt : null);
        ws.send((frame.buffer as ArrayBuffer).slice(0));
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
        setMicError("캡처 장치와의 연결이 끊겼습니다(USB 분리 등). 장치를 다시 연결한 뒤 재시작하세요.");
        cleanup();
        onStatusChange("error");
        return;
      }
      setMicError("네이티브 캡처가 예기치 않게 종료되었습니다.");
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
