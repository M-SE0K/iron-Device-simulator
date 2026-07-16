"use client";

// 캡처(V/I) 분석 세션 — MicrophonePlayer(마이크 모드)와 WaveformPlayer(파일 모드, 재생과 동시 실행)가
// 공유하는 캡처 파이프라인. 네이티브 CoreAudio(Electron) 또는 getUserMedia(웹/모바일 폴백)로
// ch0(V)/ch1(I)를 캡처해 WASM에 분석시키고, 세션 동안의 전 채널 원본 PCM을 보존했다가
// 정지 후 "저장" 요청 시 WAV로 내보낸다. MicrophonePlayer.tsx에서 그대로 이관된 로직이다.
import { useCallback, useEffect, useRef, useState } from "react";
import { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import { perf } from "@/features/audio/lib/perf/collector";
import { createAnalysisSocket, type SocketLike } from "@/features/audio/lib/engine/protocol/local-socket";
import { useCalibration } from "@/features/audio/components/calibration/CalibrationContext";
import { pcmFramesToWavBlob } from "@/features/audio/lib/codec/wav-encoder";
import { BYTES_PER_SAMPLE } from "@/features/audio/lib/engine/core";
import { useNativeCapture, type NativeRawCapture } from "./useNativeCapture";
import { useWebAudioWorkletCapture } from "./useWebAudioWorkletCapture";
import { buildInitMessage } from "../stream/buildInitMessage";

/** 저장 요청 시 상위(DashboardClient)로 넘기는 전 채널 캡처 내보내기 */
export interface CaptureRecordingExport {
  blob: Blob; // N채널 인터리브 int16 WAV — ch0=V, ch1=I, ch2.. 확장 채널
  channels: number;
  sampleRate: number;
  durationSec: number;
}

/**
 * 원본 캡처 청크(N채널 인터리브 int16) 실시간 스트림 — ChartDetailOverlay의 채널 뷰가
 * Blob을 폴링하는 대신 이 이벤트를 구독해 청크가 들어오는 즉시(useNativeCapture의 rawFrame
 * 콜백과 같은 타이밍) 반영한다. "reset"은 새 세션이 시작돼 이전 누적 상태를 버려야 함을 알린다.
 */
export type CaptureStreamEvent =
  | { type: "reset"; channels: number; sampleRate: number }
  | { type: "chunk"; chunk: ArrayBuffer; channels: number; sampleRate: number };
export type CaptureStreamListener = (ev: CaptureStreamEvent) => void;

export interface UseCaptureSessionDeps {
  /** 세션 상태 — 호출자(MicrophonePlayer: 캡처 상태 그 자체 / WaveformPlayer: 재생과 공유) */
  status: AppStatus;
  onStatusChange: (s: AppStatus) => void;
  onFrameReceived: (frame: AnalysisFrame) => void;
  onStreamStart: () => void;
  onSaveRecording?: (rec: CaptureRecordingExport) => Promise<void> | void;
  inputParams: InputParameterValues | undefined;
}

export function useCaptureSession(deps: UseCaptureSessionDeps) {
  const {
    status, onStatusChange, onFrameReceived, onStreamStart,
    onSaveRecording, inputParams,
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
  // play-capture(파일 재생+캡처 단일 IOProc) 헬퍼 활성 여부 — cleanup/pause/resume가
  // window.audioPlayCapture를 제어할지 판단한다 (nativeActiveRef의 재생판).
  const playCaptureActiveRef = useRef(false);
  // 전 채널 원본 PCM 세션 버퍼 — 정지 후에도 유지되어 "저장" 시 전 채널 WAV로 내보낸다.
  // 다음 세션 시작 시 useNativeCapture가 새 버퍼로 교체한다.
  const rawCaptureRef  = useRef<NativeRawCapture | null>(null);
  // 저장용 원본 버퍼 축적 on/off — 재생 일시정지 중에는 이걸 꺼서 저장 파일에 무음 구간이
  // 섞이지 않게 한다(pauseRecording/resumeRecording).
  const recordingActiveRef = useRef(true);
  // 분석(WASM) 프레임 전송 on/off — 재생 일시정지 중에는 꺼서 소켓 frameCount(= 차트 시간축)와
  // WASM 온도 누적을 그 자리에 고정한다. 세션(소켓/캡처) 자체는 유지되므로 재개 시 끊김 없이
  // 이어진다(정지 지점 10s → 재개 시 10s부터). 새 세션 시작(ready) 시 true로 복구된다.
  const analysisActiveRef = useRef(true);
  const isActiveRef    = useRef(false);
  const frameCountRef  = useRef(0);
  const framesRcvdRef  = useRef(0);
  // 원본 캡처 청크 실시간 구독자 목록 — ChartDetailOverlay의 채널 뷰가 여기에 등록해서
  // 폴링 없이 청크 도착 즉시 알림을 받는다.
  const streamListenersRef = useRef<Set<CaptureStreamListener>>(new Set());
  const emitStreamEvent = useCallback((ev: CaptureStreamEvent) => {
    streamListenersRef.current.forEach((fn) => fn(ev));
  }, []);
  const subscribeCaptureStream = useCallback((fn: CaptureStreamListener) => {
    streamListenersRef.current.add(fn);
    return () => { streamListenersRef.current.delete(fn); };
  }, []);

  const isRecording = status === "playing";

  // ── 정리: 네이티브 캡처 / 스트림 / AudioContext / WebSocket 전부 종료 ──────
  const cleanup = useCallback(() => {
    isActiveRef.current = false;
    perf.endSession();

    nativeOffsRef.current.forEach((off) => off());
    nativeOffsRef.current = [];
    if (nativeActiveRef.current) {
      nativeActiveRef.current = false;
      window.audioCapture?.stop();
    }
    if (playCaptureActiveRef.current) {
      playCaptureActiveRef.current = false;
      window.audioPlayCapture?.stop();
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
  }, []);

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
      ws.send(buildInitMessage(inputParams, { sampleRate: actualRate, samplesPerCh }));
    };

    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      // 4. Decoding — 수신 메시지 도착(여기)부터 파싱 → AnalysisFrame 구성 완료까지를 잰다.
      const recvAt = performance.now();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg: Record<string, any> = JSON.parse(e.data);

      if (msg.type === "ready") {
        isActiveRef.current = true;
        analysisActiveRef.current = true;
        frameCountRef.current = 0;
        framesRcvdRef.current = 0;
        onStatusChange("playing");
        onStreamStart();

      } else if (msg.type === "frame") {
        framesRcvdRef.current++;
        const frame: AnalysisFrame = {
          time:        msg.time        as number,
          temperature: msg.temperature as [number, number],
          excursion:   msg.excursion   as [number, number],
        };
        // 3. WASM 분석(processingMs) + 4. Decoding — 1·2단계(캡처/인코딩)는 send 시점에
        // 큐잉된 값과 프레임 순서로 페어링된다(collector.markFrameSent 참고).
        perf.recordFrame(frame.time, msg.processingMs as number, performance.now() - recvAt);
        onFrameReceived(frame);

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
  }, [inputParams, onStatusChange, onStreamStart, onFrameReceived, cleanup]);

  // ── 캡처 경로 (네이티브 CoreAudio / 웹 getUserMedia 폴백) ────────────────────
  const { start: startNativeCapture } = useNativeCapture({
    nativeOffsRef, nativeActiveRef, playCaptureActiveRef, rawCaptureRef, recordingActiveRef, analysisActiveRef,
    isActiveRef, frameCountRef,
    onStatusChange, setMicError, setSampleRate, setDeviceName,
    setActualBufferSize, openAnalysisSocket, cleanup, emitStreamEvent,
  });
  const { start: startWebCapture } = useWebAudioWorkletCapture({
    audioCtxRef, streamRef, workletRef, analysisActiveRef, isActiveRef, frameCountRef,
    setSampleRate, setDeviceName, setActualBufferSize, setActualLatency,
    openAnalysisSocket,
  });

  // ── 세션 시작 ───────────────────────────────────────────────────────────────
  // options.playbackPcm이 있으면(Electron 파일 모드) play-capture 헬퍼로 재생+캡처를 단일
  // IOProc에서 돌린다 — onPlaybackEnded는 재생이 끝까지 도달했을 때(헬퍼 exit 0) 불린다.
  // 웹 폴백 경로에는 재생 개념이 없으므로 무시된다(웹 파일 모드는 WaveSurfer가 재생 담당).
  const start = useCallback(async (options?: {
    playbackPcm?: Float32Array;
    onPlaybackEnded?: () => void;
  }) => {
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
          playback: options?.playbackPcm
            ? { pcm: options.playbackPcm, onEnded: options.onPlaybackEnded ?? (() => {}) }
            : undefined,
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

  // ── 저장 — 세션 버퍼의 전 채널(int16 인터리브) PCM을 WAV로 인코딩해 상위로 넘긴다 ──────
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

  // 분석 소켓에 임의 JSON 제어 메시지를 보낸다(WaveformPlayerHandle.sendMessage 계약 유지 —
  // MicrophonePlayer 시절 useAnalysisStream.sendMessage와 동일).
  const sendMessage = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  // ── 재생 일시정지/재개 — 세션(소켓/캡처 연결) 자체는 유지한 채 분석 프레임 전송과 저장 버퍼
  // 축적만 함께 멈춘다. 세션을 통째로 끊고 재개 시 다시 열면 WASM 온도 누적 상태가 리셋되고
  // 차트도 지워지므로, 대신 데이터 흐름만 멈춘다. 분석을 멈추면 소켓 frameCount(= 차트 시간축)와
  // WASM 온도가 정지 지점에 고정되어, 재개 시 시간축이 튀지 않고 그 지점부터 이어진다.
  // play-capture 세션이면 헬퍼의 재생 위치도 함께 동결/재개한다(출력 무음 + playPos 정지).
  // 헬퍼의 캡처 스트림은 pause 중에도 계속 흐르지만 위 두 게이트가 버리므로, 차트·저장 버퍼·
  // 진행바(캡처 프레임 수 기반)가 모두 정지 지점에 고정된다.
  const pauseRecording = useCallback(() => {
    recordingActiveRef.current = false;
    analysisActiveRef.current = false;
    if (playCaptureActiveRef.current) window.audioPlayCapture?.control("pause");
  }, []);
  const resumeRecording = useCallback(() => {
    recordingActiveRef.current = true;
    analysisActiveRef.current = true;
    if (playCaptureActiveRef.current) window.audioPlayCapture?.control("resume");
  }, []);

  // 언마운트 시 정리
  useEffect(() => () => { cleanup(); }, [cleanup]);

  return {
    start, stop, cleanup, isRecording,
    micError, sampleRate, deviceName, actualBufferSize, actualLatency,
    saveRecording, hasRecording, saving, recordingChannels,
    getRecordedBlob, sendMessage, pauseRecording, resumeRecording,
    subscribeCaptureStream,
    frameCountRef, framesRcvdRef,
  };
}
