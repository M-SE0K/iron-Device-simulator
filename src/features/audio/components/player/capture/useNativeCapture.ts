"use client";

// Electron 네이티브 CoreAudio 캡처 경로 (MicrophonePlayer 전용).
// 상주 헬퍼(audio-device-helper capture)가 캡처 I/O(IOProc)를 직접 소유하므로
// BufferFrameSize가 실제로 적용·유지된다 — getUserMedia 경로에서는 캡처를 여는
// Chromium이 버퍼 크기의 주인이라(TN2321) 요청값을 강제할 수 없었다.
import { useCallback, type MutableRefObject } from "react";
import type { AppStatus } from "@/features/audio/types";
import type { StreamDebugInfo } from "@/features/audio/lib/debug/types";
import type { SocketLike } from "@/features/audio/lib/engine/protocol/local-socket";
import { createNativeFrameReframer } from "./reframeNativeChunk";

export interface NativeCaptureParams {
  sampleRate: number;
  bufferSize: number;
  /** calibration.channels (문자열) — 최소 2ch로 보정된다 */
  channels: string;
  /** calibration.captureDeviceUID — 빈 문자열이면 OS 기본 입력 */
  captureDeviceUID: string;
}

/**
 * 캡처 세션 동안 메모리에 보존하는 N채널 인터리브 int32 원본 PCM.
 * 엔진에는 ch0(V)/ch1(I)만 나가지만, Calibration에서 확장한 나머지 채널도 여기 남아
 * 사용자가 저장을 요청하면 전 채널이 WAV로 내보내진다. 다음 캡처 시작 시 교체된다.
 * (메모리 사용: 8ch·48kHz 기준 약 1.5MB/s — 명시적 저장 전까지만 유지되는 세션 버퍼)
 */
export interface NativeRawCapture {
  channels: number;
  sampleRate: number;
  frames: ArrayBuffer[]; // wireSamplesPerCh sample-frame × channels, int32 인터리브
}

export interface NativeCaptureDeps {
  nativeOffsRef: MutableRefObject<Array<() => void>>;
  nativeActiveRef: MutableRefObject<boolean>;
  /** 전 채널 원본 PCM 보존 버퍼 — 캡처 시작 시 새로 초기화되고 세션 내내 축적된다. */
  rawCaptureRef: MutableRefObject<NativeRawCapture | null>;
  /**
   * true인 동안만 rawCaptureRef에 프레임을 쌓는다 — 분석 소켓(WASM)에는 항상 보내지만
   * 저장용 원본 버퍼 축적은 일시정지할 수 있게 분리한다(WaveformPlayer의 재생 일시정지 시
   * "녹음도 함께 멈춤" 기대와 저장 파일에 무음 구간이 안 섞이게 하려는 목적).
   */
  recordingActiveRef: MutableRefObject<boolean>;
  isActiveRef: MutableRefObject<boolean>;
  frameCountRef: MutableRefObject<number>;
  lastSendAtRef: MutableRefObject<number>;
  onDebugUpdate: (info: Partial<StreamDebugInfo>) => void;
  onStatusChange: (s: AppStatus) => void;
  setMicError: (msg: string | null) => void;
  setSampleRate: (v: number | null) => void;
  setDeviceName: (v: string | null) => void;
  setActualBufferSize: (v: number | null) => void;
  openAnalysisSocket: (actualRate: number, samplesPerCh: number) => SocketLike;
  cleanup: () => void;
}

export function useNativeCapture(deps: NativeCaptureDeps) {
  const {
    nativeOffsRef, nativeActiveRef, rawCaptureRef, recordingActiveRef, isActiveRef, frameCountRef, lastSendAtRef,
    onDebugUpdate, onStatusChange, setMicError, setSampleRate, setDeviceName,
    setActualBufferSize, openAnalysisSocket, cleanup,
  } = deps;

  const start = useCallback(async (params: NativeCaptureParams) => {
    const nativeCapture = window.audioCapture;
    if (!nativeCapture) throw new Error("네이티브 캡처 브리지를 사용할 수 없습니다.");

    // 캡처 채널 수 — Calibration에서 장치 스펙(inputChannels) 이하로 지정한다.
    // 엔진 분석에는 ch0(V)/ch1(I)만 쓰이고, 나머지 채널은 rawCaptureRef에 보존된다.
    const captureChannels = Math.max(2, Number(params.channels) || 2);
    const res = await nativeCapture.start({
      sampleRate: params.sampleRate,
      bufferSize: params.bufferSize,
      channels:   captureChannels,
      deviceUID:  params.captureDeviceUID?.trim() || undefined,
    });
    if (!res.success) {
      throw new Error(`네이티브 캡처 시작 실패: ${res.error ?? "unknown"}`);
    }
    nativeActiveRef.current = true;
    const actualRate = res.actual?.sampleRate ?? params.sampleRate;
    // 와이어로 나가는 프레임 크기 — 장치가 실제 적용한 bufferSize를 우선한다(sampleRate와
    // 동일한 "actual 우선" 원칙). 이 값이 그대로 init 메시지의 bufferSize로 실려
    // ff_prot_start_exec의 dt 계산에 쓰인다.
    const wireSamplesPerCh = res.actual?.bufferSize ?? params.bufferSize;
    setSampleRate(actualRate);
    setActualBufferSize(res.actual?.bufferSize ?? null);
    setDeviceName(res.device || null);

    const ws = openAnalysisSocket(actualRate, wireSamplesPerCh);

    // 새 캡처 세션 시작 — 이전 세션의 전 채널 버퍼를 교체한다(저장하지 않았다면 여기서 소멸).
    rawCaptureRef.current = { channels: captureChannels, sampleRate: actualRate, frames: [] };
    recordingActiveRef.current = true;

    const reframe = createNativeFrameReframer(
      captureChannels,
      wireSamplesPerCh,
      (frame) => {
        lastSendAtRef.current = performance.now();
        // Int32Array.buffer는 ArrayBuffer | SharedArrayBuffer → 명시적 캐스트. outPcm은
        // 재사용하므로 slice(0)로 복사본 전송.
        ws.send((frame.buffer as ArrayBuffer).slice(0));
        const sent = ++frameCountRef.current;
        if (sent % 10 === 0) onDebugUpdate({ framesSent: sent });
      },
      (rawFrame) => {
        // 저장용 원본 버퍼는 recordingActiveRef가 꺼져 있으면(재생 일시정지 중) 쌓지 않는다 —
        // 분석(onFrame/WASM)은 계속 흘러가되, 저장 파일에는 무음 구간이 섞이지 않게 한다.
        if (!recordingActiveRef.current) return;
        // outRaw도 재사용 버퍼 → 복사본을 세션 메모리에 축적 (전 채널, 프레임 순서 보존)
        rawCaptureRef.current?.frames.push((rawFrame.buffer as ArrayBuffer).slice(0));
      },
    );

    const offData = nativeCapture.onData((chunk) => {
      if (!isActiveRef.current || ws.readyState !== WebSocket.OPEN) return;
      reframe(chunk);
    });
    const offEnded = nativeCapture.onEnded(() => {
      if (!isActiveRef.current) return;
      setMicError("네이티브 캡처가 예기치 않게 종료되었습니다.");
      cleanup();
      onStatusChange("error");
    });
    nativeOffsRef.current = [offData, offEnded];
  }, [
    nativeOffsRef, nativeActiveRef, rawCaptureRef, recordingActiveRef, isActiveRef, frameCountRef, lastSendAtRef,
    onDebugUpdate, onStatusChange, setMicError, setSampleRate, setDeviceName,
    setActualBufferSize, openAnalysisSocket, cleanup,
  ]);

  return { start };
}
