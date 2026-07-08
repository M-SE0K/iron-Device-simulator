"use client";

// 실시간 분석 스트림(WaveformPlayer 전용) — 소켓 open/close, rAF 전송 루프, RTT/디버그 텔레메트리.
// PCM 프레임은 usePcmDecoder가 미리 만들어 두고, 이 훅은 WaveSurfer 재생 시각(getCurrentTime)을
// 기준으로 미전송 프레임을 소켓에 흘려보낸다.
import { useCallback, useRef, type MutableRefObject } from "react";
import type { AnalysisFrame, AppStatus, InputParameterValues } from "@/features/audio/types";
import type { DebugLogEntry, StreamDebugInfo } from "@/features/audio/lib/debug/types";
import { createAnalysisSocket, type SocketLike } from "@/features/audio/lib/engine/protocol/local-socket";
import type { EngineRuntimeConfig } from "@/features/audio/lib/engine/core";
import { buildInitMessage } from "./buildInitMessage";

export interface UseAnalysisStreamDeps {
  wavesurferRef: MutableRefObject<import("wavesurfer.js").default | null>;
  pcmFramesRef: MutableRefObject<ArrayBuffer[]>;
  engineConfigRef: MutableRefObject<EngineRuntimeConfig>;
  inputParamsRef: MutableRefObject<InputParameterValues | undefined>;
  onStreamStart: () => void;
  onFrameReceived: (frame: AnalysisFrame) => void;
  onStatusChange: (status: AppStatus) => void;
  onDebugUpdate?: (info: Partial<StreamDebugInfo>) => void;
  onDebugLog?: (entry: DebugLogEntry) => void;
}

export function useAnalysisStream(deps: UseAnalysisStreamDeps) {
  const {
    wavesurferRef, pcmFramesRef, engineConfigRef, inputParamsRef,
    onStreamStart, onFrameReceived, onStatusChange, onDebugUpdate, onDebugLog,
  } = deps;

  const wsRef            = useRef<SocketLike | null>(null);
  const wsReadyRef       = useRef(false);
  const rafRef           = useRef<number | null>(null);
  const lastSentFrameRef = useRef(0);

  // ── 레이턴시 측정 ─────────────────────────────────────────────────────────
  const sendTimestampsRef    = useRef<Map<number, number>>(new Map());
  const framesSentRef        = useRef(0);
  const framesReceivedRef    = useRef(0);
  const rttSamplesRef        = useRef<number[]>([]); // 최근 100개
  const lastServerProcMsRef  = useRef<number | null>(null);
  const lastSendRateCheckRef = useRef<{ time: number; count: number }>({ time: 0, count: 0 });
  const sendRateFpsRef       = useRef<number | null>(null);
  const lastDebugFlushRef    = useRef(0);

  const flushDebug = useCallback((wsConnected: boolean) => {
    if (!onDebugUpdate) return;
    const now = performance.now();
    if (now - lastDebugFlushRef.current < 100) return; // 100ms 미만이면 스킵
    lastDebugFlushRef.current = now;

    const samples = rttSamplesRef.current;
    const avgRttMs = samples.length > 0
      ? parseFloat((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2))
      : null;
    const minRttMs = samples.length > 0 ? parseFloat(Math.min(...samples).toFixed(2)) : null;
    const maxRttMs = samples.length > 0 ? parseFloat(Math.max(...samples).toFixed(2)) : null;
    const latestRttMs = samples.length > 0
      ? parseFloat(samples[samples.length - 1].toFixed(2))
      : null;

    onDebugUpdate({
      wsConnected,
      framesSent:        framesSentRef.current,
      framesReceived:    framesReceivedRef.current,
      latestRttMs,
      avgRttMs,
      minRttMs,
      maxRttMs,
      serverProcessingMs: lastServerProcMsRef.current,
      sendRateFps:        sendRateFpsRef.current,
    });
  }, [onDebugUpdate]);

  const stopRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // ── rAF 루프: WaveSurfer currentTime 기준으로 미전송 프레임 일괄 전송 ─────
  const startRaf = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    const loop = () => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !wsReadyRef.current) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      const wv = wavesurferRef.current;
      if (!wv) return;

      const { sampleRate, samplesPerCh } = engineConfigRef.current;
      const currentFrame = Math.floor(wv.getCurrentTime() * sampleRate / samplesPerCh);
      const frames       = pcmFramesRef.current;
      const now          = performance.now();

      while (lastSentFrameRef.current < currentFrame && lastSentFrameRef.current < frames.length) {
        const idx = lastSentFrameRef.current;
        sendTimestampsRef.current.set(idx, performance.now());
        ws.send(frames[idx]);
        framesSentRef.current++;
        lastSentFrameRef.current++;
      }

      // 전송 속도 측정 (1초 윈도우)
      const rateCheck = lastSendRateCheckRef.current;
      if (now - rateCheck.time >= 1000) {
        sendRateFpsRef.current = parseFloat(
          ((framesSentRef.current - rateCheck.count) / ((now - rateCheck.time) / 1000)).toFixed(1)
        );
        lastSendRateCheckRef.current = { time: now, count: framesSentRef.current };
      }

      flushDebug(true);
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
  }, [flushDebug, wavesurferRef, pcmFramesRef, engineConfigRef]);

  const close = useCallback(() => {
    stopRaf();
    const ws = wsRef.current;
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "stop" }));
      }
      ws.close();
      wsRef.current = null;
    }
    wsReadyRef.current = false;
    lastSentFrameRef.current = 0;
  }, [stopRaf]);

  const resetTelemetry = useCallback(() => {
    sendTimestampsRef.current.clear();
    framesSentRef.current        = 0;
    framesReceivedRef.current    = 0;
    rttSamplesRef.current        = [];
    lastServerProcMsRef.current  = null;
    sendRateFpsRef.current       = null;
    lastSendRateCheckRef.current = { time: 0, count: 0 };
    onDebugUpdate?.({ wsConnected: false, framesSent: 0, framesReceived: 0,
      latestRttMs: null, avgRttMs: null, minRttMs: null, maxRttMs: null,
      serverProcessingMs: null, sendRateFps: null });
  }, [onDebugUpdate]);

  /** 새 세션(파일 변경 등) 시작 전 정리 — 스트림 종료 + 텔레메트리 초기화. */
  const reset = useCallback(() => {
    close();
    resetTelemetry();
  }, [close, resetTelemetry]);

  // ── WebSocket 연결 + 스트리밍 시작 ───────────────────────────────────────
  const open = useCallback(() => {
    // 이미 연결 중이면 재사용
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && wsReadyRef.current) {
      startRaf();
      return;
    }

    // 이전 연결 정리
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    lastSentFrameRef.current = 0;
    wsReadyRef.current = false;
    onStreamStart(); // 누적 프레임 초기화 신호

    const ws = createAnalysisSocket();
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(buildInitMessage(inputParamsRef.current, engineConfigRef.current));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string);
      if (msg.type === "ready") {
        wsReadyRef.current = true;
        startRaf();
      } else if (msg.type === "frame") {
        // ── RTT 계산 ──────────────────────────────────────────────────────
        const recvAt    = performance.now();
        const { sampleRate, samplesPerCh } = engineConfigRef.current;
        const frameIdx  = Math.round((msg.time as number) * sampleRate / samplesPerCh);
        const sentAt    = sendTimestampsRef.current.get(frameIdx);
        if (sentAt !== undefined) {
          const rtt = parseFloat((recvAt - sentAt).toFixed(2));
          const samples = rttSamplesRef.current;
          samples.push(rtt);
          if (samples.length > 100) samples.shift();
          sendTimestampsRef.current.delete(frameIdx);

          // 콘솔 로그 (매 50프레임마다 출력)
          if (framesReceivedRef.current % 50 === 0) {
            const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
            console.debug(
              `[Latency] frame#${frameIdx} | RTT: ${rtt}ms | avg: ${avg.toFixed(2)}ms | server: ${msg.processingMs}ms`
            );
          }
        }
        lastServerProcMsRef.current = msg.processingMs as number;
        framesReceivedRef.current++;

        const temperature = msg.temperature as [number, number];
        const excursion   = msg.excursion   as [number, number];

        // ── 수신 데이터 진단 로그 (첫 3프레임 + 100프레임마다) ────────────────
        if (framesReceivedRef.current < 3 || framesReceivedRef.current % 100 === 0) {
          const isArray = Array.isArray(msg.temperature);
          console.debug(
            `[useAnalysisStream] frame#${frameIdx}` +
            `  isArray=${isArray}` +
            `  T=[${temperature[0]}, ${temperature[1]}]` +
            `  Exc=[${excursion[0]}, ${excursion[1]}]`
          );
          if (!isArray) {
            console.warn("[useAnalysisStream] temperature/excursion이 배열이 아닙니다. WASM 엔진 버전을 확인하세요.");
          }
        }

        // 로그 엔트리 생성 (render 타임은 DashboardClient 쪽에서 첨부)
        // DebugLogEntry는 단일값 — ch0(L)을 대표값으로 사용
        onDebugLog?.({
          receivedAt:        recvAt,
          audioTime:         msg.time        as number,
          frameIdx,
          rttMs:             sentAt !== undefined
            ? parseFloat((recvAt - sentAt).toFixed(2))
            : null,
          serverProcMs:      msg.processingMs as number,
          temperature:       temperature[0],
          excursion:         excursion[0],
          reactRenderMs:     null,
          echartsRenderMs:   null,
          totalRecvRenderMs: null,
          freshnessLagMs:    null,
        });

        onFrameReceived({
          time: msg.time as number,
          temperature,
          excursion,
        });

        flushDebug(true);
      } else if (msg.type === "error") {
        console.error("[useAnalysisStream] 분석 엔진 오류:", msg.message);
        onStatusChange("error");
      }
    };

    ws.onerror = () => {
      console.error("[useAnalysisStream] WebSocket 연결 오류");
      onStatusChange("error");
    };

    ws.onclose = () => {
      wsReadyRef.current = false;
      onDebugUpdate?.({ wsConnected: false });
    };
  }, [startRaf, onStreamStart, onFrameReceived, onStatusChange, onDebugUpdate, onDebugLog, flushDebug, inputParamsRef, engineConfigRef]);

  // ── 일시정지 (WebSocket 유지 → 재개 시 스트림/차트 보존) ──────────────────
  const pauseStream = useCallback(() => {
    stopRaf();
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "pause" }));
    }
  }, [stopRaf]);

  const sendMessage = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  return { open, close, reset, pauseStream, sendMessage };
}
