"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Mic, Square } from "lucide-react";
import { AppStatus, AnalysisFrame, StreamDebugInfo, DebugLogEntry, InputParameterValues } from "@/features/audio/types";
import { createAnalysisSocket, type SocketLike } from "@/features/audio/lib/engine/protocol/local-socket";
import { encodeToInt16 } from "@/features/audio/lib/engine/utils";
import { useCalibration } from "@/features/audio/components/calibration/Calibration-context";

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

  // ── 녹음 시작 ───────────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    setMicError(null);

    try {
      const reqSampleRate = Number(calibration.sampleRate) || 48000;
      const reqBufferSize = Number(calibration.bufferSize) || 480;
      // 캘리브레이션에서 고른 입력 장치(MediaDevices deviceId). ""=시스템 기본.
      const selectedDeviceId = calibration.inputDeviceId?.trim() || "";

      const nativeCapture = typeof window !== "undefined" ? window.audioCapture : undefined;

      // Electron(네이티브 브리지 존재)에서는 항상 네이티브 CoreAudio 캡처를 쓴다 — 헬퍼가 이제
      // Capture Device(CoreAudio UID)로 임의 입력 장치를 열 수 있어(버퍼 크기 제어 유지) getUserMedia로
      // 우회할 필요가 없다. 브리지가 없는 웹/모바일 빌드에서만 getUserMedia로 폴백하며, 그 경로에선
      // Input Device(MediaDevices deviceId)로 장치를 지정한다. (두 장치 선택 UI는 빌드별로 분리됨)
      if (nativeCapture) {
        // ── 네이티브 CoreAudio 캡처 (Electron 전용) ────────────────────────
        // 상주 헬퍼(audio-device-helper capture)가 캡처 I/O(IOProc)를 직접 소유하므로
        // BufferFrameSize가 실제로 적용·유지된다. getUserMedia 경로에서는 캡처를 여는
        // Chromium이 버퍼 크기의 주인이라(TN2321) 요청값을 강제할 수 없었다.
        // 캡처 채널 수 (calibration에서 설정, 최소 2). MCHStreamer 등 다채널 장치의 V/I 센싱
        // 채널을 받으려면 늘린다 — 단, 분석 파이프라인은 항상 ch0/ch1(L/R)만 사용한다.
        const captureChannels = Math.max(2, Number(calibration.channels) || 2);
        // 캡처 대상 장치 — calibration에서 고른 CoreAudio UID("" = OS 기본 입력)
        const res = await nativeCapture.start({
          sampleRate: reqSampleRate,
          bufferSize: reqBufferSize,
          channels:   captureChannels,
          deviceUID:  calibration.captureDeviceUID?.trim() || undefined,
        });
        if (!res.success) {
          throw new Error(`네이티브 캡처 시작 실패: ${res.error ?? "unknown"}`);
        }
        nativeActiveRef.current = true;
        const actualRate = res.actual?.sampleRate ?? reqSampleRate;
        // 와이어로 나가는 프레임 크기 — 장치가 실제 적용한 bufferSize를 우선한다(sampleRate와 동일한
        // "actual 우선" 원칙). 이 값이 그대로 init 메시지의 bufferSize로 실려 ff_prot_start_exec의
        // dt 계산에 쓰인다.
        const wireSamplesPerCh = res.actual?.bufferSize ?? reqBufferSize;
        setSampleRate(actualRate);
        setActualBufferSize(res.actual?.bufferSize ?? null);
        setDeviceName(res.device || null);

        const ws = openAnalysisSocket(actualRate, wireSamplesPerCh);

        // 헬퍼 청크(int16 N채널 인터리브, 장치 버퍼 단위) → ch0/ch1만 뽑아 wireSamplesPerCh 샘플
        // 2ch 프레임으로 재구성. device 버퍼가 wireSamplesPerCh와 다르거나(예: 512) 채널이 2가
        // 아니어도, 미완성 device-frame 잔여 바이트(pending)와 미완성 출력 프레임(outCount)을
        // 이월해 프레임 경계를 유지한다.
        const bytesPerDeviceFrame = captureChannels * 2; // int16
        let pending = new Uint8Array(0);
        const outPcm = new Int16Array(wireSamplesPerCh * 2); // wireSamplesPerCh sample-frame × 2ch
        let outCount = 0; // 현재 채워진 출력 sample-frame 수
        const offData = nativeCapture.onData((chunk) => {
          if (!isActiveRef.current || ws.readyState !== WebSocket.OPEN) return;
          const merged = new Uint8Array(pending.length + chunk.length);
          merged.set(pending);
          merged.set(chunk, pending.length);
          const view = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
          let byteOff = 0;
          while (merged.length - byteOff >= bytesPerDeviceFrame) {
            outPcm[outCount * 2]     = view.getInt16(byteOff, true);     // ch0 (L)
            outPcm[outCount * 2 + 1] = view.getInt16(byteOff + 2, true); // ch1 (R)
            outCount++;
            byteOff += bytesPerDeviceFrame;
            if (outCount === wireSamplesPerCh) {
              lastSendAtRef.current = performance.now();
              ws.send(outPcm.buffer.slice(0)); // outPcm은 재사용하므로 복사본 전송
              outCount = 0;
              const sent = ++frameCountRef.current;
              if (sent % 10 === 0) onDebugUpdate({ framesSent: sent });
            }
          }
          pending = merged.slice(byteOff);
        });
        const offEnded = nativeCapture.onEnded(() => {
          if (!isActiveRef.current) return;
          setMicError("네이티브 캡처가 예기치 않게 종료되었습니다.");
          cleanup();
          onStatusChange("error");
        });
        nativeOffsRef.current = [offData, offEnded];
        return;
      }

      // ── 웹 getUserMedia 캡처 (브라우저 폴백) ─────────────────────────────
      // BufferSize는 캡처를 여는 Chromium이 주인이라 강제할 수 없고, latency 제약으로
      // 힌트만 전달한다 (반영 보장 없음 — 진짜 제어는 위 네이티브 경로).
      const latencyHint = reqBufferSize / reqSampleRate;

      // 1) 마이크 권한 요청
      // latency는 lib.dom.d.ts의 MediaTrackConstraints에 아직 없어(신규/실험적 제약) 캐스팅한다.
      const audioConstraints: MediaTrackConstraints & { latency?: ConstrainDouble } = {
        channelCount:     2,
        sampleRate:       { ideal: reqSampleRate },
        latency:          { ideal: latencyHint },
        echoCancellation: false,  // 스피커 보호 분석 — 원음 필요
        noiseSuppression: false,
        autoGainControl:  false,
      };
      // 캘리브레이션에서 특정 입력 장치를 골랐으면 그 장치로 정확히 캡처(exact) — 미지정 시 기본 장치.
      if (selectedDeviceId) {
        audioConstraints.deviceId = { exact: selectedDeviceId };
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      streamRef.current = stream;
      // 웹 캡처 경로에서도 실제 장치 이름을 표시(네이티브 경로처럼)
      setDeviceName(stream.getAudioTracks()[0]?.label || calibration.inputDeviceLabel || null);

      // 실제 협상된 latency 확인(요청이 그대로 반영됐다는 보장은 없음 — 참고용 표시)
      const trackSettings = stream.getAudioTracks()[0]?.getSettings() as MediaTrackSettings & { latency?: number };
      setActualLatency(trackSettings?.latency ?? null);

      // 2) AudioContext 생성 (실제 샘플레이트 확인)
      const ctx           = new AudioContext();
      audioCtxRef.current = ctx;
      if (ctx.state === "suspended") await ctx.resume();
      const actualRate    = ctx.sampleRate;
      setSampleRate(actualRate);

      // 3) AudioWorklet 로드 — reqBufferSize를 processorOptions로 전달해 워클릿이 그 샘플 수
      // 단위로 청킹하게 한다. sampleRate/latency와 달리 이건 브라우저가 협상하는 값이 아니라
      // 워클릿 코드가 그대로 지키는 값이므로(mic-processor.js), 화면에도 요청값 그대로 표시한다.
      await ctx.audioWorklet.addModule("/mic-processor.js");
      const worklet = new AudioWorkletNode(ctx, "mic-processor", {
        processorOptions: { samplesPerCh: reqBufferSize },
      });
      workletRef.current = worklet;
      setActualBufferSize(reqBufferSize);

      // 4) MediaStream → Worklet → 무음 GainNode (destination 필요, 스피커 출력 방지)
      const source      = ctx.createMediaStreamSource(stream);
      const silentGain  = ctx.createGain();
      silentGain.gain.value = 0;
      source.connect(worklet);
      worklet.connect(silentGain);
      silentGain.connect(ctx.destination);

      // 5) 분석 소켓 연결 (브라우저 WASM 엔진, LocalWasmSocket)
      const ws = openAnalysisSocket(actualRate, reqBufferSize);

      // 6) Worklet 프레임 → WebSocket 전송
      worklet.port.onmessage = (e: MessageEvent<{ L: Float32Array; R: Float32Array }>) => {
        if (!isActiveRef.current || ws.readyState !== WebSocket.OPEN) return;

        const interleaved = encodeToInt16(e.data.L, e.data.R);
        lastSendAtRef.current = performance.now();
        ws.send(interleaved.buffer as ArrayBuffer);

        const sent = ++frameCountRef.current;
        if (sent % 10 === 0) onDebugUpdate({ framesSent: sent });
      };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Permission") || msg.includes("NotAllowed")) {
        setMicError("마이크 권한이 거부되었습니다. 브라우저 설정에서 허용해주세요.");
      } else {
        setMicError(msg);
      }
      cleanup();
    }
  }, [calibration, openAnalysisSocket, onStatusChange, onDebugUpdate, cleanup]);

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
