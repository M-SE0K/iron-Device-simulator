"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Mic, Square } from "lucide-react";
import { AppStatus, AnalysisFrame, StreamDebugInfo, DebugLogEntry } from "@/lib/types";
import type { InputParameterValues } from "./InputParameters";

// ─── 처리 상수 ────────────────────────────────────────────────────────────────
const SAMPLES_PER_CH = 480;
const FRAME_BYTES    = SAMPLES_PER_CH * 2 * 2; // 1920 bytes

interface Props {
  status: AppStatus;
  onStatusChange: (s: AppStatus) => void;
  onFrameReceived: (frame: AnalysisFrame) => void;
  onStreamStart: () => void;
  onDebugUpdate: (info: Partial<StreamDebugInfo>) => void;
  onDebugLog?: (entry: DebugLogEntry) => void;
  inputParams: InputParameterValues;
}

// ─── WebSocket URL (WaveformPlayer와 동일 엔드포인트) ────────────────────────
function getWsUrl(): string {
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/audio`;
}

// ─── Float32 → Int16 인터리브 변환 ───────────────────────────────────────────
function encodeToInt16(L: Float32Array, R: Float32Array): ArrayBuffer {
  const pcm = new Int16Array(SAMPLES_PER_CH * 2);
  for (let i = 0; i < SAMPLES_PER_CH; i++) {
    pcm[i * 2]     = Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767)));
    pcm[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767)));
  }
  return pcm.buffer;
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
  const [micError,    setMicError]    = useState<string | null>(null);
  const [sampleRate,  setSampleRate]  = useState<number | null>(null);

  const wsRef          = useRef<WebSocket | null>(null);
  const audioCtxRef    = useRef<AudioContext | null>(null);
  const streamRef      = useRef<MediaStream | null>(null);
  const workletRef     = useRef<AudioWorkletNode | null>(null);
  const isActiveRef    = useRef(false);
  const frameCountRef  = useRef(0);
  const lastSendAtRef  = useRef(0);
  const framesRcvdRef  = useRef(0);

  const isRecording = status === "playing";

  // ── 정리: 스트림 / AudioContext / WebSocket 전부 종료 ─────────────────────
  const cleanup = useCallback(() => {
    isActiveRef.current = false;

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
    onDebugUpdate({ wsConnected: false });
  }, [onDebugUpdate]);

  const stop = useCallback(() => {
    cleanup();
    onStatusChange("idle");
  }, [cleanup, onStatusChange]);

  // ── 녹음 시작 ───────────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    setMicError(null);

    try {
      // 1) 마이크 권한 요청
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount:     2,
          sampleRate:       { ideal: 48000 },
          echoCancellation: false,  // 스피커 보호 분석 — 원음 필요
          noiseSuppression: false,
          autoGainControl:  false,
        },
      });
      streamRef.current = stream;

      // 2) AudioContext 생성 (실제 샘플레이트 확인)
      const ctx           = new AudioContext();
      audioCtxRef.current = ctx;
      if (ctx.state === "suspended") await ctx.resume();
      const actualRate    = ctx.sampleRate;
      setSampleRate(actualRate);

      // 3) AudioWorklet 로드
      await ctx.audioWorklet.addModule("/mic-processor.js");
      const worklet = new AudioWorkletNode(ctx, "mic-processor");
      workletRef.current = worklet;

      // 4) MediaStream → Worklet → 무음 GainNode (destination 필요, 스피커 출력 방지)
      const source      = ctx.createMediaStreamSource(stream);
      const silentGain  = ctx.createGain();
      silentGain.gain.value = 0;
      source.connect(worklet);
      worklet.connect(silentGain);
      silentGain.connect(ctx.destination);

      // 5) WebSocket 연결
      const ws      = new WebSocket(getWsUrl());
      wsRef.current = ws;
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        onDebugUpdate({ wsConnected: true, framesSent: 0, framesReceived: 0 });
        ws.send(JSON.stringify({
          type:           "init",
          ampOutputPower: inputParams.ampOutputPower ?? "",
          speakerModel:   inputParams.speakerModel   ?? "",
          sampleRate:     actualRate,
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
        setMicError("WebSocket 연결 오류. 서버가 실행 중인지 확인해주세요.");
        cleanup();
        onStatusChange("error");
      };

      ws.onclose = () => {
        if (isActiveRef.current) {
          cleanup();
          onStatusChange("idle");
        }
      };

      // 6) Worklet 프레임 → WebSocket 전송
      worklet.port.onmessage = (e: MessageEvent<{ L: Float32Array; R: Float32Array }>) => {
        if (!isActiveRef.current || ws.readyState !== WebSocket.OPEN) return;

        const buf = encodeToInt16(e.data.L, e.data.R);
        lastSendAtRef.current = performance.now();
        ws.send(buf);

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
  }, [inputParams, onStatusChange, onFrameReceived, onStreamStart, onDebugUpdate, onDebugLog, cleanup]);

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
          {sampleRate !== null && (
            <span className="text-xs text-iron-400 font-mono">
              {sampleRate.toLocaleString()} Hz
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
