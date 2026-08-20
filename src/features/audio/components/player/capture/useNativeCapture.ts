"use client";

import { useCallback, type MutableRefObject } from "react";
import type { AppStatus } from "@/features/audio/types";
import type { EngineClient } from "@/features/audio/lib/engine/protocol/engine-client";
import { clampCaptureChannels, CHANNELS, CURRENT_CHANNEL } from "@/features/audio/lib/engine/core";
import { isIronPerfEnabled, recordPerfSample } from "@/shared/lib/iron-perf";
import { encodeToInt16, zeroChannel } from "@/features/audio/lib/engine/utils";
import { PcmFrameStore } from "@/features/audio/lib/pcm-frame-store";
import { humanizeIpcError } from "@/shared/lib/ipc-error";
import type { CaptureStreamEvent, PlaybackMode, PlaybackStreamPump } from "./types";
import { createNativeFrameReframer } from "./reframeNativeChunk";

const PLAYBACK_PREFILL_MS = 40;

const PLAYBACK_WRITE_BATCH_MS = 10;

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
    pcm: Float32Array;
    onEnded: () => void;
    outputChannel?: number;
    outputChannelR?: number;
    mode?: PlaybackMode;
  };
}

export interface NativeCaptureDeps {
  nativeOffsRef: MutableRefObject<Array<() => void>>;
  nativeActiveRef: MutableRefObject<boolean>;
  playCaptureActiveRef: MutableRefObject<boolean>;
  rawCaptureRef: MutableRefObject<PcmFrameStore | null>;
  recordingActiveRef: MutableRefObject<boolean>;
  analysisActiveRef: MutableRefObject<boolean>;
  isActiveRef: MutableRefObject<boolean>;
  streamPumpRef: MutableRefObject<PlaybackStreamPump | null>;
  /** 스피커 open 상태 래치 — 서면 캡처 원본의 ch1(I)을 0 으로 덮는다. */
  speakerOpenRef: MutableRefObject<boolean>;
  onStatusChange: (s: AppStatus) => void;
  setMicError: (msg: string | null) => void;
  openEngineClient: (actualRate: number, samplesPerCh: number, expectedPlaybackFrames: number) => EngineClient;
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
    isActiveRef, streamPumpRef, speakerOpenRef,
    onStatusChange, setMicError, openEngineClient, cleanup, emitStreamEvent,
  } = deps;

  const start = useCallback(async (params: NativeCaptureParams) => {
    const { playback } = params;
    const streaming = !!playback && playback.mode !== "original";

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
      const playbackOpts = {
        ...baseOpts,
        outputChannel: playback.outputChannel,
        outputChannelR: playback.outputChannelR,
      };
      res = streaming
        ? await playCapture.start({ ...playbackOpts, stream: true, prefillMs: PLAYBACK_PREFILL_MS })
        : await playCapture.start({
            ...playbackOpts,
            refWriteId: await uploadPlaybackRef(playCapture, playback.pcm),
            refChannels: 2,
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
    const actualChannels = res.channels ?? captureChannels;

    const totalPlaybackFrames = playback
      ? Math.ceil(playback.pcm.length / 2 / wireSamplesPerCh)
      : 0;

    const client = openEngineClient(actualRate, wireSamplesPerCh, totalPlaybackFrames);

    const expectedCaptureFrames = totalPlaybackFrames > 0
      ? totalPlaybackFrames
        + Math.ceil(totalPlaybackFrames * 0.05)
        + Math.ceil((2 * actualRate) / wireSamplesPerCh)
      : undefined;
    rawCaptureRef.current = new PcmFrameStore({
      channels: actualChannels,
      sampleRate: actualRate,
      samplesPerFrame: wireSamplesPerCh,
      expectedFrames: expectedCaptureFrames,
    });
    recordingActiveRef.current = true;
    emitStreamEvent({ type: "reset", channels: actualChannels, sampleRate: actualRate });

    const batchFrames = Math.max(
      1,
      Math.round((PLAYBACK_WRITE_BATCH_MS / 1000) * actualRate / wireSamplesPerCh),
    );
    const prefillFrames = Math.ceil((PLAYBACK_PREFILL_MS / 1000) * actualRate / wireSamplesPerCh);
    const leadFrames = prefillFrames + batchFrames;

    let producedFrames = 0;
    let capturedFrames = 0;
    let writtenFrames  = 0;
    const latestSensing = new Int16Array(wireSamplesPerCh * CHANNELS);

    /* --dev 계측 게이지 — 셋 다 단위는 "와이어 프레임"(1프레임 = wireSamplesPerCh/rate 초,
     * capturedFrames/producedFrames 와 동일 단위)으로 통일한다.
     *   stream_lead:          엔진 선행분(생산−캡처)
     *   stream_write_backlog: 헬퍼로 못 보내고 대기 중인 보호 PCM
     *   stream_ring_est:      전송분−캡처 재생분 — 단일 클록이라 캡처 수 ≒ 재생 위치,
     *                         IPC 비행분까지 포함한 링 백로그 상한 추정 */
    const perfOn = isIronPerfEnabled();
    let sentFrames = 0;
    let pendingFrameCount = 0;

    const pendingWrites: Int16Array[] = [];
    let writeInFlight = false;
    let endRequested = false;
    let endSent = false;

    const takePendingWrites = (): Int16Array => {
      pendingFrameCount = 0;
      if (pendingWrites.length === 1) return pendingWrites.pop()!;
      let total = 0;
      for (const part of pendingWrites) total += part.length;
      const merged = new Int16Array(total);
      let offset = 0;
      for (const part of pendingWrites) {
        merged.set(part, offset);
        offset += part.length;
      }
      pendingWrites.length = 0;
      return merged;
    };

    const drainWrites = () => {
      if (writeInFlight) return;
      const bridge = window.audioPlayCapture;
      if (!bridge) return;
      if (pendingWrites.length >= batchFrames || (endRequested && pendingWrites.length > 0)) {
        writeInFlight = true;
        const mergedPcm = takePendingWrites();
        sentFrames += mergedPcm.length / (CHANNELS * wireSamplesPerCh);
        void bridge.writePcm(mergedPcm).finally(() => {
          writeInFlight = false;
          drainWrites();
        });
        return;
      }
      if (endRequested && pendingWrites.length === 0 && !endSent) {
        endSent = true;
        void bridge.control("end");
      }
    };

    const produceFrames = () => {
      while (producedFrames < totalPlaybackFrames && producedFrames - capturedFrames < leadFrames) {
        if (client.closed) return;
        const audioBuf = buildAudioBufFrame(playback?.pcm ?? null, producedFrames++, wireSamplesPerCh);
        client.sendFrame(concatFrames(audioBuf, latestSensing));
      }
    };

    if (streaming) {
      streamPumpRef.current = {
        onEngineReady: () => {
          produceFrames();
          if (totalPlaybackFrames === 0) {
            endRequested = true;
            drainWrites();
          }
        },
        pushProtected: (processed) => {
          pendingWrites.push(processed);
          if (perfOn) {
            pendingFrameCount += 1;
            recordPerfSample("stream_write_backlog", pendingFrameCount);
          }
          if (++writtenFrames >= totalPlaybackFrames) endRequested = true;
          drainWrites();
        },
      };
    }

    let emittedFrames = 0;
    const reframe = createNativeFrameReframer(
      actualChannels,
      wireSamplesPerCh,
      (frame) => {
        if (!analysisActiveRef.current) return;
        if (client.closed) return;
        if (streaming) {
          latestSensing.set(frame);
          capturedFrames++;
          if (perfOn) {
            recordPerfSample("stream_lead", producedFrames - capturedFrames);
            recordPerfSample("stream_ring_est", sentFrames - capturedFrames);
          }
          produceFrames();
          return;
        }
        const audioBuf = buildAudioBufFrame(playback?.pcm ?? null, emittedFrames++, wireSamplesPerCh);
        client.sendFrame(concatFrames(audioBuf, frame));
      },
      (rawFrame) => {
        if (!recordingActiveRef.current) return;
        const store = rawCaptureRef.current;
        if (!store) return;
        /* 스피커 open(온도 ≥ 500°C) 이후로는 전류가 흐르지 않으므로 ch1(I)을 0 으로 덮는다.
         * reframe 이 onFrame(분석 프레임) 을 먼저 부르고 이 콜백을 뒤에 부르며 두 버퍼가
         * 따로라, 여기서 덮어도 엔진에 들어간 i_sensing 은 영향받지 않는다. store.append 가
         * 복사해 담으므로 차트 스트림·백필·원본 줌·저장 WAV 가 모두 같은 값을 본다. */
        if (speakerOpenRef.current) zeroChannel(rawFrame, actualChannels, CURRENT_CHANNEL);
        const view = store.append(rawFrame);
        emitStreamEvent({ type: "chunk", chunk: view, channels: actualChannels, sampleRate: actualRate });
      },
    );

    const bridge = playback ? window.audioPlayCapture! : window.audioCapture!;
    /* ipc_chunk_gap: 헬퍼 청크의 도착 "간격" 분포 — 프로세스 간 클록이 달라 절대 지연은
     * 못 재지만, 기대값(bufferSize/rate)보다 벌어지는 꼬리가 릴레이/메인 스레드 정체의
     * 신호다. reframe: 청크당 리프레이밍(JS DataView 루프) 소요. */
    let lastChunkAt = 0;
    const offData = bridge.onData((chunk) => {
      if (client.closed) return;
      if (!perfOn) {
        reframe(chunk);
        return;
      }
      const now = performance.now();
      if (lastChunkAt > 0) recordPerfSample("ipc_chunk_gap", now - lastChunkAt);
      lastChunkAt = now;
      reframe(chunk);
      recordPerfSample("reframe", performance.now() - now);
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
      if (info.code === 4) {
        setMicError("Playback didn't start — the protection engine didn't deliver audio in time. Try again, or switch playback to Original.");
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
    isActiveRef, streamPumpRef, speakerOpenRef,
    onStatusChange, setMicError, openEngineClient, cleanup, emitStreamEvent,
  ]);

  return { start };
}
