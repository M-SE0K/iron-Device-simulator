"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Mic, Square } from "lucide-react";
import { AppStatus, AnalysisFrame, StreamDebugInfo, DebugLogEntry, InputParameterValues } from "@/features/audio/types";
import { createAnalysisSocket, type SocketLike } from "@/features/audio/lib/engine/protocol/local-socket";
import { useCalibration } from "@/features/audio/components/calibration/Calibration-context";
import { useNativeCapture } from "./capture/useNativeCapture";
import { useWebAudioWorkletCapture } from "./capture/useWebAudioWorkletCapture";

interface Props {
  status: AppStatus;
  onStatusChange: (s: AppStatus) => void;
  onFrameReceived: (frame: AnalysisFrame) => void;
  onStreamStart: () => void;
  onDebugUpdate: (info: Partial<StreamDebugInfo>) => void;
  onDebugLog?: (entry: DebugLogEntry) => void;
  inputParams: InputParameterValues;
}

export default function MicrophonePlayer({
  status,
  onStatusChange,
  onFrameReceived,
  onStreamStart,
  onDebugUpdate,
  onDebugLog,
  inputParams,
}: Props) {
  const { values: calibration } = useCalibration();

  const [micError,         setMicError]         = useState<string | null>(null);
  const [sampleRate,       setSampleRate]       = useState<number | null>(null);
  const [actualLatency,    setActualLatency]    = useState<number | null>(null);
  const [deviceName,       setDeviceName]       = useState<string | null>(null);
  const [actualBufferSize, setActualBufferSize] = useState<number | null>(null);

  const wsRef          = useRef<SocketLike | null>(null);
  const audioCtxRef    = useRef<AudioContext | null>(null);
  const streamRef      = useRef<MediaStream | null>(null);
  const workletRef     = useRef<AudioWorkletNode | null>(null);
  const nativeOffsRef  = useRef<Array<() => void>>([]); // 네이티브 캡처 IPC 리스너 해제 함수들
  const nativeActiveRef = useRef(false);
  const isActiveRef    = useRef(false);
  const frameCountRef  = useRef(0);
  const lastSendAtRef  = useRef(0);
  const framesRcvdRef  = useRef(0);

  const isRecording = status === "playing";

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
    onDebugUpdate({ wsConnected: false });
  }, [onDebugUpdate]);

  const stop = useCallback(() => {
    cleanup();
    onStatusChange("idle");
  }, [cleanup, onStatusChange]);

  // ── 분석 소켓 연결 + 공통 핸들러 (네이티브/웹 캡처 공용) ────────────────────
  const openAnalysisSocket = useCallback((actualRate: number, samplesPerCh: number): SocketLike => {
    const ws      = createAnalysisSocket();
    wsRef.current = ws;

    ws.onopen = () => {
      onDebugUpdate({ wsConnected: true, framesSent: 0, framesReceived: 0 });
      ws.send(JSON.stringify({
        type:           "init",
        ampOutputPower: inputParams.ampOutputPower ?? "",
        speakerModel:   inputParams.speakerModel   ?? "",
        sampleRate:     actualRate,
        bufferSize:     samplesPerCh,
      }));
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
        onDebugUpdate({
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
    nativeOffsRef, nativeActiveRef, isActiveRef, frameCountRef, lastSendAtRef,
    onDebugUpdate, onStatusChange, setMicError, setSampleRate, setDeviceName,
    setActualBufferSize, openAnalysisSocket, cleanup,
  });
  const { start: startWebCapture } = useWebAudioWorkletCapture({
    audioCtxRef, streamRef, workletRef, isActiveRef, frameCountRef, lastSendAtRef,
    onDebugUpdate, setSampleRate, setDeviceName, setActualBufferSize, setActualLatency,
    openAnalysisSocket,
  });

  // ── 녹음 시작 ───────────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    setMicError(null);

    try {
      const reqSampleRate = Number(calibration.sampleRate) || 48000;
      const reqBufferSize = Number(calibration.bufferSize) || 480;

      // Electron(네이티브 브리지 존재)에서는 항상 네이티브 CoreAudio 캡처를 쓴다 — 헬퍼가 이제
      // Capture Device(CoreAudio UID)로 임의 입력 장치를 열 수 있어(버퍼 크기 제어 유지) getUserMedia로
      // 우회할 필요가 없다. 브리지가 없는 웹/모바일 빌드에서만 getUserMedia로 폴백하며, 그 경로에선
      // Input Device(MediaDevices deviceId)로 장치를 지정한다. (두 장치 선택 UI는 빌드별로 분리됨)
      if (typeof window !== "undefined" && window.audioCapture) {
        await startNativeCapture({
          sampleRate:       reqSampleRate,
          bufferSize:       reqBufferSize,
          channels:         calibration.channels,
          captureDeviceUID: calibration.captureDeviceUID ?? "",
        });
        return;
      }

      // 캘리브레이션에서 고른 입력 장치(MediaDevices deviceId). ""=시스템 기본.
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

  // 언마운트 시 정리
  useEffect(() => () => { cleanup(); }, [cleanup]);

  return (
    <div className="card p-4 flex flex-col gap-3">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full transition-all ${
              isRecording ? "bg-red-500 animate-pulse" : "bg-iron-300"
            }`}
          />
          <span className="text-sm font-medium text-iron-700">
            {isRecording ? "녹음 중" : "마이크 대기"}
          </span>
          {deviceName !== null && (
            <span className="text-xs text-iron-400 font-mono">{deviceName}</span>
          )}
          {sampleRate !== null && (
            <span className="text-xs text-iron-400 font-mono">
              {sampleRate.toLocaleString()} Hz
            </span>
          )}
          {actualBufferSize !== null && (
            <span className="text-xs text-iron-400 font-mono">
              buf {actualBufferSize}
            </span>
          )}
          {actualLatency !== null && (
            <span className="text-xs text-iron-400 font-mono">
              latency {(actualLatency * 1000).toFixed(1)}ms
            </span>
          )}
        </div>

        <button
          onClick={isRecording ? stop : start}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
            isRecording
              ? "bg-red-500 hover:bg-red-600 text-white"
              : "bg-brand-blue hover:bg-blue-700 text-white"
          }`}
        >
          {isRecording ? (
            <><Square size={13} /> 중지</>
          ) : (
            <><Mic size={13} /> 녹음 시작</>
          )}
        </button>
      </div>

      {/* 오류 메시지 */}
      {micError && (
        <p className="text-xs text-red-500 px-1">{micError}</p>
      )}

      {/* 안내 */}
      {!isRecording && !micError && (
        <p className="text-xs text-iron-300 text-center py-2">
          녹음을 시작하면 마이크 오디오가 실시간으로 분석됩니다
        </p>
      )}

      {/* 녹음 중 프레임 카운터 */}
      {isRecording && (
        <div className="flex items-center justify-center gap-4 text-xs font-mono text-iron-400">
          <span>송신 {frameCountRef.current} fr</span>
          <span className="text-iron-200">|</span>
          <span>수신 {framesRcvdRef.current} fr</span>
        </div>
      )}
    </div>
  );
}
