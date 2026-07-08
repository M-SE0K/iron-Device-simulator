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

export interface NativeCaptureDeps {
  nativeOffsRef: MutableRefObject<Array<() => void>>;
  nativeActiveRef: MutableRefObject<boolean>;
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
    nativeOffsRef, nativeActiveRef, isActiveRef, frameCountRef, lastSendAtRef,
    onDebugUpdate, onStatusChange, setMicError, setSampleRate, setDeviceName,
    setActualBufferSize, openAnalysisSocket, cleanup,
  } = deps;

  const start = useCallback(async (params: NativeCaptureParams) => {
    const nativeCapture = window.audioCapture;
    if (!nativeCapture) throw new Error("네이티브 캡처 브리지를 사용할 수 없습니다.");

    // 캡처 채널 수. MCHStreamer 등 다채널 장치의 V/I 센싱 채널을 받으려면 늘린다 —
    // 단, 분석 파이프라인은 항상 ch0/ch1(L/R)만 사용한다.
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

    const reframe = createNativeFrameReframer(captureChannels, wireSamplesPerCh, (frame) => {
      lastSendAtRef.current = performance.now();
      // Int16Array.buffer는 ArrayBuffer | SharedArrayBuffer → 명시적 캐스트. outPcm은
      // 재사용하므로 slice(0)로 복사본 전송.
      ws.send((frame.buffer as ArrayBuffer).slice(0));
      const sent = ++frameCountRef.current;
      if (sent % 10 === 0) onDebugUpdate({ framesSent: sent });
    });

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
    nativeOffsRef, nativeActiveRef, isActiveRef, frameCountRef, lastSendAtRef,
    onDebugUpdate, onStatusChange, setMicError, setSampleRate, setDeviceName,
    setActualBufferSize, openAnalysisSocket, cleanup,
  ]);

  return { start };
}
