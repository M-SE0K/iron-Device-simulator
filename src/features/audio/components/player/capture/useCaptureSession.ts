"use client";

// 캡처(V/I) 분석 세션 — MicrophonePlayer(마이크 모드)와 WaveformPlayer(파일 모드, 재생과 동시 실행)가
// 공유하는 캡처 파이프라인. 네이티브 CoreAudio(Electron) 또는 getUserMedia(웹/모바일 폴백)로
// ch0(V)/ch1(I)를 캡처해 WASM에 분석시키고, 세션 동안의 전 채널 원본 PCM을 보존했다가
// 정지 후 "저장" 요청 시 WAV로 내보낸다. MicrophonePlayer.tsx에서 그대로 이관된 로직이다.
import { useCallback, useEffect, useRef, useState } from "react";
import { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import { StreamDebugInfo, DebugLogEntry } from "@/features/audio/lib/debug/types";
import { createAnalysisSocket, type SocketLike } from "@/features/audio/lib/engine/protocol/local-socket";
import { useCalibration } from "@/features/audio/components/calibration/CalibrationContext";
import { pcmFramesToWavBlob } from "@/features/audio/lib/wav-encoder";
import { BYTES_PER_SAMPLE } from "@/features/audio/lib/engine/core";
import { useNativeCapture, type NativeRawCapture } from "./useNativeCapture";
import { useWebAudioWorkletCapture } from "./useWebAudioWorkletCapture";
import { buildInitMessage } from "../stream/buildInitMessage";

/** 저장 요청 시 상위(DashboardClient)로 넘기는 전 채널 캡처 내보내기 */
export interface CaptureRecordingExport {
  blob: Blob; // N채널 인터리브 int32 WAV — ch0=V, ch1=I, ch2.. 확장 채널
  channels: number;
  sampleRate: number;
  durationSec: number;
}

export interface UseCaptureSessionDeps {
  /** 세션 상태 — 호출자(MicrophonePlayer: 캡처 상태 그 자체 / WaveformPlayer: 재생과 공유) */
  status: AppStatus;
  onStatusChange: (s: AppStatus) => void;
  onFrameReceived: (frame: AnalysisFrame) => void;
  onStreamStart: () => void;
  onDebugUpdate?: (info: Partial<StreamDebugInfo>) => void;
  onDebugLog?: (entry: DebugLogEntry) => void;
  onSaveRecording?: (rec: CaptureRecordingExport) => Promise<void> | void;
  inputParams: InputParameterValues | undefined;
}

export function useCaptureSession(deps: UseCaptureSessionDeps) {
  const {
    status, onStatusChange, onFrameReceived, onStreamStart,
    onDebugUpdate, onDebugLog, onSaveRecording, inputParams,
  } = deps;
  const { values: calibration } = useCalibration();

  const [micError, setMicError] = useState<string | null>(null);
  const [sampleRate, setSampleRate] = useState<number | null>(null);
  const [actualLatency, setActualLatency] = useState<number | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [actualBufferSize, setActualBufferSize] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const wsRef          = useRef<SocketLike | null>(null);
  const audioCtxRef    = useRef<AudioContext | null>(null);
  const streamRef      = useRef<MediaStream | null>(null);
  const workletRef     = useRef<AudioWorkletNode | null>(null);
  const nativeOffsRef  = useRef<Array<() => void>>([]); // 네이티브 캡처 IPC 리스너 해제 함수들
  const nativeActiveRef = useRef(false);
  // 전 채널 원본 PCM 세션 버퍼 — 정지 후에도 유지되어 "저장" 시 전 채널 WAV로 내보낸다.
  // 다음 세션 시작 시 useNativeCapture가 새 버퍼로 교체한다.
  const rawCaptureRef  = useRef<NativeRawCapture | null>(null);
  // 저장용 원본 버퍼 축적 on/off — 분석(WASM)은 계속 흘러가되, 재생 일시정지 중에는 이걸
  // 꺼서 저장 파일에 무음 구간이 섞이지 않게 한다(pauseRecording/resumeRecording).
  const recordingActiveRef = useRef(true);
  const isActiveRef    = useRef(false);
  const frameCountRef  = useRef(0);
  const lastSendAtRef  = useRef(0);
  const framesRcvdRef  = useRef(0);

  const isRecording = status === "playing";

  // useNativeCapture/useWebAudioWorkletCapture는 onDebugUpdate를 필수 콜백으로 받는다
  // (MicrophonePlayer 시절 그대로) — WaveformPlayer 등 선택적으로 넘기는 호출자를 위해 래핑.
  const emitDebugUpdate = useCallback((info: Partial<StreamDebugInfo>) => {
    onDebugUpdate?.(info);
  }, [onDebugUpdate]);

  // ── 정리: 네이티브 캡처 / 스트림 / AudioContext / WebSocket 전부 종료 ──────
  const cleanup = useCallback(() => {
    isActiveRef.current = false;

    nativeOffsRef.current.forEach((off) => off());
    nativeOffsRef.current = [];
    if (nativeActiveRef.current) {
      nativeActiveRef.current = false;
      window.audioCapture?.stop();
    }

    workletRef.current?.port.close();
    workletRef.current?.disconnect();
    workletRef.current = null;

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    audioCtxRef.current?.close();
    audioCtxRef.current = null;

    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "stop" }));
      ws.close();
    }

    frameCountRef.current = 0;
    framesRcvdRef.current = 0;
    setActualLatency(null);
    setDeviceName(null);
    setActualBufferSize(null);
    onDebugUpdate?.({ wsConnected: false });
  }, [onDebugUpdate]);

  /** 정리 + 세션을 "idle"로 전이 — 독립형 캡처 세션(마이크 모드)의 "중지" 버튼용. */
  const stop = useCallback(() => {
    cleanup();
    onStatusChange("idle");
  }, [cleanup, onStatusChange]);

  // ── 분석 소켓 연결 + 공통 핸들러 (네이티브/웹 캡처 공용) ────────────────────
  const openAnalysisSocket = useCallback((actualRate: number, samplesPerCh: number): SocketLike => {
    const ws      = createAnalysisSocket();
    wsRef.current = ws;

    ws.onopen = () => {
      onDebugUpdate?.({ wsConnected: true, framesSent: 0, framesReceived: 0 });
      ws.send(buildInitMessage(inputParams, { sampleRate: actualRate, samplesPerCh }));
    };

    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg: Record<string, any> = JSON.parse(e.data);

      if (msg.type === "ready") {
        isActiveRef.current = true;
        frameCountRef.current = 0;
        framesRcvdRef.current = 0;
        onStatusChange("playing");
        onStreamStart();

      } else if (msg.type === "frame") {
        const recvAt  = performance.now();
        const rttMs   = lastSendAtRef.current > 0
          ? parseFloat((recvAt - lastSendAtRef.current).toFixed(2))
          : null;

        framesRcvdRef.current++;
        onFrameReceived({
          time:        msg.time        as number,
          temperature: msg.temperature as [number, number],
          excursion:   msg.excursion   as [number, number],
        });
        onDebugUpdate?.({
          framesReceived:     framesRcvdRef.current,
          latestRttMs:        rttMs,
          serverProcessingMs: msg.processingMs as number,
        });
        onDebugLog?.({
          receivedAt:        recvAt,
          audioTime:         msg.time        as number,
          frameIdx:          framesRcvdRef.current - 1,
          rttMs,
          serverProcMs:      msg.processingMs as number,
          temperature:       (msg.temperature as [number, number])[0],
          excursion:         (msg.excursion   as [number, number])[0],
          reactRenderMs:     null,
          echartsRenderMs:   null,
          totalRecvRenderMs: null,
          freshnessLagMs:    null,
        });

      } else if (msg.type === "error") {
        setMicError(msg.message as string);
        cleanup();
        onStatusChange("error");
      }
    };

    ws.onerror = () => {
      setMicError("분석 엔진 연결 오류가 발생했습니다.");
      cleanup();
      onStatusChange("error");
    };

    ws.onclose = () => {
      if (isActiveRef.current) {
        cleanup();
        onStatusChange("idle");
      }
    };

    return ws;
  }, [inputParams, onStatusChange, onStreamStart, onFrameReceived, onDebugUpdate, onDebugLog, cleanup]);

  // ── 캡처 경로 (네이티브 CoreAudio / 웹 getUserMedia 폴백) ────────────────────
  const { start: startNativeCapture } = useNativeCapture({
    nativeOffsRef, nativeActiveRef, rawCaptureRef, recordingActiveRef, isActiveRef, frameCountRef, lastSendAtRef,
    onDebugUpdate: emitDebugUpdate, onStatusChange, setMicError, setSampleRate, setDeviceName,
    setActualBufferSize, openAnalysisSocket, cleanup,
  });
  const { start: startWebCapture } = useWebAudioWorkletCapture({
    audioCtxRef, streamRef, workletRef, isActiveRef, frameCountRef, lastSendAtRef,
    onDebugUpdate: emitDebugUpdate, setSampleRate, setDeviceName, setActualBufferSize, setActualLatency,
    openAnalysisSocket,
  });

  // ── 세션 시작 ───────────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    setMicError(null);

    try {
      const reqSampleRate = Number(calibration.sampleRate) || 48000;
      const reqBufferSize = Number(calibration.bufferSize) || 480;

      // Electron(네이티브 브리지 존재)에서는 항상 네이티브 CoreAudio 캡처를 쓴다 — 헬퍼가
      // Capture Device(CoreAudio UID, 예: MCHStreamer)로 임의 입력 장치를 열 수 있어(버퍼 크기
      // 제어 유지) getUserMedia로 우회할 필요가 없다. 브리지가 없는 웹/모바일 빌드에서만
      // getUserMedia로 폴백하며, 그 경로에선 Input Device(MediaDevices deviceId)로 장치를
      // 지정한다 — MCHStreamer는 표준 UAC2.0이라 이 경로로도 잡힌다.
      if (typeof window !== "undefined" && window.audioCapture) {
        await startNativeCapture({
          sampleRate:       reqSampleRate,
          bufferSize:       reqBufferSize,
          channels:         calibration.channels,
          captureDeviceUID: calibration.captureDeviceUID ?? "",
        });
        return;
      }

      await startWebCapture({
        sampleRate:       reqSampleRate,
        bufferSize:       reqBufferSize,
        inputDeviceId:    calibration.inputDeviceId?.trim() || "",
        inputDeviceLabel: calibration.inputDeviceLabel,
      });

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Permission") || msg.includes("NotAllowed")) {
        setMicError("마이크 권한이 거부되었습니다. 브라우저 설정에서 허용해주세요.");
      } else {
        setMicError(msg);
      }
      cleanup();
    }
  }, [calibration, startNativeCapture, startWebCapture, cleanup]);

  // ── 저장 — 세션 버퍼의 전 채널(int32 인터리브) PCM을 WAV로 인코딩해 상위로 넘긴다 ──────
  // 엔진에 나간 ch0(V)/ch1(I)뿐 아니라 Calibration에서 확장한 모든 채널이 담긴다.
  const saveRecording = useCallback(async () => {
    const raw = rawCaptureRef.current;
    if (!raw || raw.frames.length === 0 || !onSaveRecording) return;
    setSaving(true);
    try {
      const blob = pcmFramesToWavBlob(raw.frames, raw.sampleRate, raw.channels);
      const totalSampleFrames =
        raw.frames.reduce((sum, f) => sum + f.byteLength, 0) / (raw.channels * BYTES_PER_SAMPLE);
      await onSaveRecording({
        blob,
        channels:    raw.channels,
        sampleRate:  raw.sampleRate,
        durationSec: totalSampleFrames / raw.sampleRate,
      });
    } finally {
      setSaving(false);
    }
  }, [onSaveRecording]);

  // 세션이 돌고 있지 않고 버퍼에 데이터가 남아 있으면 저장 가능
  const hasRecording = !isRecording && (rawCaptureRef.current?.frames.length ?? 0) > 0;
  // 저장 버튼 라벨용 — 세션 버퍼에 실제로 담긴 채널 수(마이크 모드: Calibration Capture Channels)
  const recordingChannels = rawCaptureRef.current?.channels ?? null;

  // 세션 버퍼를 동기적으로 WAV Blob으로 인코딩해 반환한다(호출자가 직접 저장 파이프라인을
  // 소유할 때 사용 — WaveformPlayer가 DashboardClient의 handleSaveToWorkspace에 동기 반환하는
  // 용도). saveRecording()과 달리 onSaveRecording 콜백/저장 상태(saving)를 거치지 않는다.
  const getRecordedBlob = useCallback((): Blob | null => {
    const raw = rawCaptureRef.current;
    if (!raw || raw.frames.length === 0) return null;
    return pcmFramesToWavBlob(raw.frames, raw.sampleRate, raw.channels);
  }, []);

  // 분석 소켓에 임의 JSON 메시지를 보낸다(현재는 렌더 텔레메트리 역전송 용도 — 소비하는
  // 곳은 없고 실패해도 무해하다. MicrophonePlayer 시절 useAnalysisStream.sendMessage와 동일).
  const sendMessage = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  // ── 저장 버퍼 일시정지/재개 — 세션(소켓/캡처 연결) 자체는 유지한 채 rawCaptureRef 축적만
  // on/off 한다. WaveformPlayer의 재생 일시정지에 연결해 쓴다: 세션을 통째로 끊고 재생 재개 시
  // 다시 열면 WASM 온도 누적 상태가 리셋되고 차트도 지워지므로, 그 대신 저장 버퍼만 멈춘다.
  const pauseRecording = useCallback(() => {
    recordingActiveRef.current = false;
  }, []);
  const resumeRecording = useCallback(() => {
    recordingActiveRef.current = true;
  }, []);

  // 언마운트 시 정리
  useEffect(() => () => { cleanup(); }, [cleanup]);

  return {
    start, stop, cleanup, isRecording,
    micError, sampleRate, deviceName, actualBufferSize, actualLatency,
    saveRecording, hasRecording, saving, recordingChannels,
    getRecordedBlob, sendMessage, pauseRecording, resumeRecording,
    frameCountRef, framesRcvdRef,
  };
}
