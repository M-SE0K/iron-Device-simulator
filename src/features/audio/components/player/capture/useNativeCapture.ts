"use client";

import { useCallback, type MutableRefObject } from "react";
import type { AppStatus } from "@/features/audio/types";
import type { SocketLike } from "@/features/audio/lib/engine/protocol/socket-types";
import { clampCaptureChannels, CHANNELS } from "@/features/audio/lib/engine/core";
import { encodeToInt16 } from "@/features/audio/lib/engine/utils";
import { humanizeIpcError } from "@/shared/lib/ipc-error";
import type { CaptureStreamEvent, PlaybackMode, PlaybackStreamPump } from "./types";
import { createNativeFrameReframer } from "./reframeNativeChunk";

/**
 * 보호 스트리밍 재생에서 헬퍼가 소리를 내기 전에 링에 채워둘 분량.
 * 렌더러 지터(GC·메인 스레드 정체)를 흡수하는 완충이자 곧 재생 시작 지연이다 —
 * 40ms면 프레임 4개(48 kHz/480) 수준이라 체감되지 않으면서 어지간한 지터를 넘긴다.
 */
const PLAYBACK_PREFILL_MS = 40;

/**
 * 보호 PCM을 헬퍼로 넘길 때 한 번에 보낼 목표 분량.
 *
 * Tauri invoke 비용은 페이로드 크기가 아니라 **호출 횟수**에 붙는데(게다가 raw body 제약 때문에
 * `audio_playcapture_write_pcm`은 sync 커맨드라 IPC 디스패치 스레드에서 인라인 실행된다),
 * bufferSize를 줄이면 데이터양은 그대로인 채 프레임 수만 늘어난다. bufferSize 16이면 초당
 * 3000회가 되어 메인 스레드가 잠기고 링이 말라 소리가 지지직거린다(실측 확인).
 * 모아 보내면 bufferSize와 무관하게 호출 빈도가 ~100 Hz로 고정된다.
 * 기본값 480에서는 한 묶음이 정확히 한 프레임이라 기존 동작과 같다.
 */
const PLAYBACK_WRITE_BATCH_MS = 10;

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
    /** "protected"면 pcm을 엔진에 통과시킨 결과를 스트리밍 재생한다(기본). types.ts 참고. */
    mode?: PlaybackMode;
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
  /** 보호 스트리밍 재생 루프의 접점 — 이 훅이 채우고 useCaptureSession이 호출한다. */
  streamPumpRef: MutableRefObject<PlaybackStreamPump | null>;
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
    isActiveRef, frameCountRef, streamPumpRef,
    onStatusChange, setMicError, setSampleRate, setDeviceName,
    setActualBufferSize, openAnalysisSocket, cleanup, emitStreamEvent,
  } = deps;

  const start = useCallback(async (params: NativeCaptureParams) => {
    const { playback } = params;
    // 보호 스트리밍 재생: 원본을 미리 통째로 올리는 대신, 엔진을 통과한 프레임을 재생 중에
    // 계속 밀어 넣는다 — 스피커에 닿는 신호가 처음부터 끝까지 보호된 신호가 된다.
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
        // 스트리밍 모드에는 선업로드가 없다 — 파일이 길수록 컸던 재생 버튼의 첫 지연도 함께 사라진다.
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

    // ── 보호 스트리밍 재생 루프 ────────────────────────────────────────────
    // 재생과 캡처가 한 IOProc(단일 클록)이라 "도착한 캡처 프레임 수 = 실제로 재생된 프레임 수"다.
    // 그래서 별도 타이머 없이 캡처 도착 자체를 크레딧으로 삼아, 재생 위치보다 leadFrames만큼만
    // 앞서 원본을 엔진에 넣고 그 결과를 헬퍼로 밀어 넣는다(자기 클로킹).
    const totalPlaybackFrames = playback
      ? Math.ceil(playback.pcm.length / 2 / wireSamplesPerCh)
      : 0;
    const batchFrames = Math.max(
      1,
      Math.round((PLAYBACK_WRITE_BATCH_MS / 1000) * actualRate / wireSamplesPerCh),
    );
    const prefillFrames = Math.ceil((PLAYBACK_PREFILL_MS / 1000) * actualRate / wireSamplesPerCh);
    // ⚠️ 헬퍼가 프리필을 채우려면 렌더러가 그만큼을 실제로 **보내야** 한다 — 배치에 물려 아직
    // 안 나간 분량은 링에 없다. 그래서 리드에 배치 한 묶음을 얹어 둔다. 이게 모자라면 링이
    // 프리필 선에 영영 도달하지 못해 재생이 시작되지 않는다(헬퍼는 결국 exit 4).
    const leadFrames = prefillFrames + batchFrames;

    let producedFrames = 0;   // 엔진에 넣은 원본 프레임 수
    let capturedFrames = 0;   // 돌아온 캡처 프레임 수 = 실제 재생 위치
    let writtenFrames  = 0;   // 헬퍼 재생 링에 밀어 넣은 보호 프레임 수
    // 실측 V/I가 아직 없는 시작 구간은 0으로 넣는다 — 아직 소리가 나가지 않았으니 소산 전력도
    // 0이고, 그래야 열 보호가 개입하지 않는다(변위 보호는 신호 자체로 결정돼 프레임 0부터 정확).
    // 이후로는 가장 최근에 도착한 캡처 프레임으로 덮어써진다.
    const latestSensing = new Int16Array(wireSamplesPerCh * CHANNELS);

    // ── 헬퍼로 보내는 쓰기 경로 ────────────────────────────────────────────
    // 진행 중인 write는 항상 하나뿐이고, 그동안 도착한 프레임은 다음 묶음으로 쌓인다. 밀릴수록
    // 묶음이 커질 뿐 호출 횟수는 늘지 않으므로, 뒤처진 만큼이 그대로 지연·메모리로 누적되던
    // 예전 프라미스 체인(상한 없음)과 달리 밀린 양이 스스로 흡수된다.
    // 하나만 띄우는 구조 자체가 순서도 보장한다 — writePcm들과 control("end")이 반드시 이
    // 순서로 헬퍼 stdin에 닿아야 하고, end가 먼저 가면 마지막 프레임을 재생하기도 전에
    // 드레인이 시작돼 끝이 잘린다.
    const pendingWrites: Int16Array[] = [];
    let writeInFlight = false;
    let endRequested = false;
    let endSent = false;

    const takePendingWrites = (): Int16Array => {
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
      // 묶음이 목표 분량에 닿았거나, 더 올 프레임이 없어 남은 걸 털어야 할 때만 내보낸다.
      if (pendingWrites.length >= batchFrames || (endRequested && pendingWrites.length > 0)) {
        writeInFlight = true;
        void bridge.writePcm(takePendingWrites()).finally(() => {
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
        if (ws.readyState !== WebSocket.OPEN) return;
        const audioBuf = buildAudioBufFrame(playback?.pcm ?? null, producedFrames++, wireSamplesPerCh);
        ws.send(concatFrames(audioBuf, latestSensing));
        ++frameCountRef.current;
      }
    };

    if (streaming) {
      streamPumpRef.current = {
        onEngineReady: () => {
          produceFrames();
          // 재생할 프레임이 0개면(0샘플 오디오) pushProtected가 한 번도 불리지 않아 끝을 알릴
          // 기회가 없다 — 그대로 두면 헬퍼가 프리필을 기다리다 타임아웃(exit 4)한다.
          if (totalPlaybackFrames === 0) {
            endRequested = true;
            drainWrites();
          }
        },
        pushProtected: (processed) => {
          pendingWrites.push(processed);
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
        // ⚠️ emittedFrames(재생 PCM에서 몇 번째 프레임을 실을지)와 소켓 내부의 frameCount
        // (그 결과가 차트 x축 어디에 놓일지)는 **반드시 같은 수를 세야 한다**. 소켓은
        // OPEN이 아닌 동안 send()를 조용히 무시하는데(local-socket.ts / worker-socket.ts),
        // 그 사이 여기서만 번호를 올리면 이후 모든 프레임에서 "재생 위치 N+D의 오디오가
        // x=N에 그려지는" 어긋남이 남는다 — Protected 파형이 Input(원본)보다 D프레임만큼
        // 앞당겨져 보이는 증상이 정확히 이것이다. 소켓과 같은 조건으로 먼저 걸러
        // 두 카운터가 갈라질 여지 자체를 없앤다.
        if (ws.readyState !== WebSocket.OPEN) return;
        if (streaming) {
          // 방금 도착한 캡처가 다음 프레임의 실측 V/I가 된다. 프레임 N에 N의 실측을 맞추는 것은
          // 인과적으로 불가능하고(재생해야 V/I가 생긴다), 그 지연(≈50–70ms)은 열 시정수(초 단위)
          // 대비 무시할 수준이다 — docs/protected-playback-plan.md §5.
          latestSensing.set(frame);
          capturedFrames++;
          produceFrames();
          return;
        }
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
      if (info.code === 4) {
        // 헬퍼가 프리필을 기다리다 포기했다 — 보호 PCM이 제때 도착하지 않았다는 뜻이라
        // (엔진 로드 실패 등) 소리는 한 번도 나가지 않은 상태다.
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
    isActiveRef, frameCountRef, streamPumpRef,
    onStatusChange, setMicError, setSampleRate, setDeviceName,
    setActualBufferSize, openAnalysisSocket, cleanup, emitStreamEvent,
  ]);

  return { start };
}
