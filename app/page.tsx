"use client";

export const dynamic = "force-dynamic";

import { useState, useCallback, useRef, useEffect } from "react";
import Header from "@/components/Header";
import AudioUploader from "@/components/AudioUploader";
import WaveformPlayer, { WaveformPlayerHandle } from "@/components/WaveformPlayer";
import MicrophonePlayer from "@/components/MicrophonePlayer";
import TemperatureChart from "@/components/TemperatureChart";
import ExcursionChart from "@/components/ExcursionChart";
import StatusPanel from "@/components/StatusPanel";
import { AppStatus, AnalysisFrame, StreamDebugInfo, DebugLogEntry, MeasurementExport } from "@/lib/types";
import DebugPanel from "@/components/DebugPanel";
import InputParameters, { InputParameterValues } from "@/components/InputParameters";
import { cn } from "@/lib/utils";

export default function DashboardPage() {
  const [status, setStatus]                   = useState<AppStatus>("idle");
  const [audioFile, setAudioFile]             = useState<File | null>(null);
  const [currentTime, setCurrentTime]         = useState(0);
  const [errorMsg, setErrorMsg]               = useState<string | null>(null);
  const [streamingFrames, setStreamingFrames] = useState<AnalysisFrame[]>([]);

  const [debugInfo, setDebugInfo] = useState<StreamDebugInfo>({
    wsConnected: false, framesSent: 0, framesReceived: 0,
    latestRttMs: null, avgRttMs: null, minRttMs: null, maxRttMs: null,
    serverProcessingMs: null, sendRateFps: null,
    reactRenderMs: null, echartsRenderMs: null,
    totalRecvRenderMs: null, totalE2eMs: null,
    freshnessLagMs: null, streamingFramesLen: 0,
    outputQueueLen: 0, sourceCount: 0, droppedFrames: 0, renderUpdateRate: null,
    preservedEvents: 0,
  });
  const [showDebug, setShowDebug] = useState(false);
  const [debugLogs, setDebugLogs] = useState<DebugLogEntry[]>([]);
  const [inputParams, setInputParams] = useState<InputParameterValues>({
    ampOutputPower: "",
    speakerModel: "",
  });
  const [inputMode, setInputMode] = useState<"file" | "mic">("file");

  // 프레임마다 setState 방지 — ref에 누적 후 100ms마다 flush
  const pendingLogsRef = useRef<DebugLogEntry[]>([]);
  const MAX_LOG_ENTRIES = 500;

  // ── WaveformPlayer ref (sendMessage 접근용) ──────────────────────────────
  const waveformRef = useRef<WaveformPlayerHandle>(null);
  // metrics 전송 간격 카운터 (10회에 1회 전송)
  const metricsCountRef    = useRef(0);
  const METRICS_INTERVAL   = 10;
  // 직전 프레임 정보 (metrics 메시지에 포함)
  const latestFrameIdxRef  = useRef(0);
  const latestAudioTimeRef = useRef(0);
  const latestRttMsRef     = useRef<number | null>(null);
  const latestSrvProcMsRef = useRef<number | null>(null);

  // ── 측정 모드 ─────────────────────────────────────────────────────────────
  const [isMeasuring, setIsMeasuring]         = useState(false);
  const [measureFrameCount, setMeasureFrameCount] = useState(0);
  const isMeasuringRef      = useRef(false);
  const measureLogsRef      = useRef<DebugLogEntry[]>([]);
  const measureStartTimeRef = useRef<number>(0);

  // ── freshness lag 계산용 refs ─────────────────────────────────────────────
  const currentTimeRef       = useRef(0);
  const latestFrameTimeRef   = useRef(0);
  // 측정 모드 중 streamingFrames 최대 길이 추적
  const maxStreamingLenRef   = useRef(0);
  // streamingFrames 길이 추적 (useCallback 의존성 회피)
  const streamingLenRef      = useRef(0);

  // ── Step 3: Output Queue ────────────────────────────────────────────────
  interface QueuedFrame {
    frame: AnalysisFrame;
    recvAt: number;
  }
  const outputQueueRef       = useRef<QueuedFrame[]>([]);
  const droppedFramesRef     = useRef(0);
  const renderTickCountRef   = useRef(0);
  const sourceCountSumRef    = useRef(0);
  const preservedEventsRef   = useRef(0);
  const eventLogRef          = useRef<{ audioTime: number; eventType: "temp_warn" | "temp_danger" | "exc_peak" }[]>([]);
  // Step 6: 직전 렌더 frame의 temperature (threshold crossing 감지용)
  const prevTempRef          = useRef<[number, number] | null>(null);
  // 렌더 업데이트 빈도 측정
  const lastRenderRateRef    = useRef<{ time: number; count: number }>({ time: 0, count: 0 });
  const renderUpdateRateRef  = useRef<number | null>(null);

  // ── 렌더 파이프라인 측정용 refs ──────────────────────────────────────────
  // 프레임 수신 시각 (WaveformPlayer → page.tsx handoff 시점)
  const frameRecvAtRef      = useRef<number>(0);
  // React useLayoutEffect 완료 시각
  const reactRenderAtRef    = useRef<number>(0);
  // 직전 RTT (로그 엔트리에 첨부용)
  const latestRttRef        = useRef<number | null>(null);
  // 직전 렌더 메트릭 (로그 엔트리에 첨부용)
  const latestRenderMetrics = useRef<{
    reactMs: number | null;
    echartsMs: number | null;
    totalRecvMs: number | null;
    totalE2eMs: number | null;
  }>({ reactMs: null, echartsMs: null, totalRecvMs: null, totalE2eMs: null });

  // ── 측정 모드 토글 + JSON 다운로드 ──────────────────────────────────────
  const handleMeasureToggle = useCallback(() => {
    if (!isMeasuringRef.current) {
      // 측정 시작
      measureLogsRef.current      = [];
      measureStartTimeRef.current = performance.now();
      maxStreamingLenRef.current  = 0;
      isMeasuringRef.current      = true;
      setIsMeasuring(true);
      setMeasureFrameCount(0);
    } else {
      // 측정 종료 → JSON 다운로드
      isMeasuringRef.current = false;
      setIsMeasuring(false);

      const logs        = measureLogsRef.current;
      const durationSec = parseFloat(
        ((performance.now() - measureStartTimeRef.current) / 1000).toFixed(3)
      );

      // ── 요약 통계 계산 ─────────────────────────────────────────────────
      const avg = (arr: number[]) =>
        arr.length > 0 ? parseFloat((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)) : null;
      const safeMin = (arr: number[]) =>
        arr.length > 0 ? parseFloat(Math.min(...arr).toFixed(2)) : null;
      const safeMax = (arr: number[]) =>
        arr.length > 0 ? parseFloat(Math.max(...arr).toFixed(2)) : null;
      const percentile = (arr: number[], p: number) => {
        if (arr.length === 0) return null;
        const sorted = [...arr].sort((a, b) => a - b);
        const idx = Math.ceil(sorted.length * p / 100) - 1;
        return parseFloat(sorted[Math.max(0, idx)].toFixed(2));
      };
      const fullStats = (arr: number[]) => ({
        avg: avg(arr), min: safeMin(arr), max: safeMax(arr),
        p50: percentile(arr, 50), p95: percentile(arr, 95), p99: percentile(arr, 99),
      });

      const rttVals  = logs.map(l => l.rttMs).filter((v): v is number => v !== null);
      const srvVals  = logs.map(l => l.serverProcMs);
      const tempVals = logs.map(l => l.temperature);
      const excVals  = logs.map(l => l.excursion);
      const recvRenderVals = logs
        .map(l => l.totalRecvRenderMs)
        .filter((v): v is number => v !== null);
      const e2eVals  = logs
        .map(l => (l.rttMs !== null && l.totalRecvRenderMs !== null)
          ? parseFloat((l.rttMs + l.totalRecvRenderMs).toFixed(2))
          : null)
        .filter((v): v is number => v !== null);
      const freshnessVals = logs
        .map(l => l.freshnessLagMs)
        .filter((v): v is number => v !== null);

      const data: MeasurementExport = {
        meta: {
          recordedAt:             new Date().toISOString(),
          audioFile:              audioFile?.name ?? null,
          measurementDurationSec: durationSec,
          frameCount:             logs.length,
        },
        summary: {
          rtt:            fullStats(rttVals),
          serverProc:     { avg: avg(srvVals) },
          recvRender:     fullStats(recvRenderVals),
          e2e:            fullStats(e2eVals),
          freshnessLag:   fullStats(freshnessVals),
          temperature:    { avg: avg(tempVals) ?? 0, min: safeMin(tempVals) ?? 0, max: safeMax(tempVals) ?? 0 },
          excursion:      { avg: avg(excVals)  ?? 0, min: safeMin(excVals)  ?? 0, max: safeMax(excVals)  ?? 0 },
          maxStreamingFramesLen: maxStreamingLenRef.current,
          totalDroppedFrames:   droppedFramesRef.current,
          droppedFrameRatio:    logs.length > 0
            ? parseFloat((droppedFramesRef.current / (droppedFramesRef.current + logs.length)).toFixed(4))
            : null,
          avgSourceCount:       renderTickCountRef.current > 0
            ? parseFloat((sourceCountSumRef.current / renderTickCountRef.current).toFixed(2))
            : null,
          preservedEvents:      preservedEventsRef.current,
          eventLog:             eventLogRef.current,
        },
        frames: logs,
      };

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `iron-device-measurement-${timestamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  }, [audioFile]);

  // ── 측정 중 프레임 카운트 UI 갱신 (200ms 간격) ───────────────────────────
  useEffect(() => {
    if (!isMeasuring) return;
    const timer = setInterval(() => {
      setMeasureFrameCount(measureLogsRef.current.length);
    }, 200);
    return () => clearInterval(timer);
  }, [isMeasuring]);

  // ── 파일 선택 / 초기화 ────────────────────────────────────────────────────
  const handleFileSelected = useCallback((file: File) => {
    setAudioFile(file);
    setStreamingFrames([]);
    setDebugLogs([]);
    pendingLogsRef.current = [];
    setCurrentTime(0);
    setStatus("idle");
    setErrorMsg(null);
    // 측정 모드 초기화
    isMeasuringRef.current = false;
    setIsMeasuring(false);
    measureLogsRef.current = [];
    setMeasureFrameCount(0);
  }, []);

  const handleReset = useCallback(() => {
    setAudioFile(null);
    setStreamingFrames([]);
    setDebugLogs([]);
    pendingLogsRef.current = [];
    setCurrentTime(0);
    setStatus("idle");
    setErrorMsg(null);
    // 측정 모드 초기화
    isMeasuringRef.current = false;
    setIsMeasuring(false);
    measureLogsRef.current = [];
    setMeasureFrameCount(0);
  }, []);

  const handleInputModeChange = useCallback((mode: "file" | "mic") => {
    setInputMode(mode);
    setStreamingFrames([]);
    setDebugLogs([]);
    pendingLogsRef.current = [];
    setCurrentTime(0);
    setStatus("idle");
    setErrorMsg(null);
    isMeasuringRef.current = false;
    setIsMeasuring(false);
    measureLogsRef.current = [];
    setMeasureFrameCount(0);
  }, []);

  const handleStreamStart = useCallback(() => {
    setStreamingFrames([]);
    outputQueueRef.current     = [];
    droppedFramesRef.current   = 0;
    renderTickCountRef.current = 0;
    sourceCountSumRef.current  = 0;
    preservedEventsRef.current = 0;
    eventLogRef.current        = [];
    prevTempRef.current        = null;
  }, []);

  // ── Step 2: Bounded State Window ─────────────────────────────────────────
  const STREAM_WINDOW = 1000;
  // ── Step 3: Render Scheduler 주기 (ms) ──────────────────────────────────
  const RENDER_INTERVAL = 15; // ~30Hz
  const isPlaying = status === "playing";

  // ── 프레임 수신 — 큐에 push만 (state update 하지 않음) ──────────────────
  const handleFrameReceived = useCallback((frame: AnalysisFrame) => {
    outputQueueRef.current.push({
      frame,
      recvAt: performance.now(),
    });
    latestFrameTimeRef.current = frame.time;
  }, []);

  // ── Step 5: Coalescing 함수 — bucket을 하나의 요약 frame으로 병합 ──────
  function coalesceFrames(bucket: QueuedFrame[]): AnalysisFrame {
    if (bucket.length === 1) return bucket[0].frame;

    const frames = bucket.map(q => q.frame);
    const latest = frames[frames.length - 1];

    return {
      ...latest,
      sourceCount: frames.length,
      timeStart:   frames[0].time,
      timeEnd:     latest.time,
      // 온도: 최신값 사용, 구간 내 최댓값 별도 보존
      temperatureMax: [
        Math.max(...frames.map(f => f.temperature[0])),
        Math.max(...frames.map(f => f.temperature[1])),
      ],
      // 익스커션: 최신값 사용, 구간 내 min/max envelope 보존
      excursionMin: [
        Math.min(...frames.map(f => f.excursion[0])),
        Math.min(...frames.map(f => f.excursion[1])),
      ],
      excursionMax: [
        Math.max(...frames.map(f => f.excursion[0])),
        Math.max(...frames.map(f => f.excursion[1])),
      ],
    };
  }

  // ── Step 6: 이벤트 감지 함수 ──────────────────────────────────────────────
  const TEMP_WARN   = 65;
  const TEMP_DANGER = 75;

  function detectEvents(bucket: QueuedFrame[], prevTemp: [number, number] | null): QueuedFrame[] {
    const events: QueuedFrame[] = [];
    for (let i = 0; i < bucket.length; i++) {
      const f = bucket[i].frame;
      const prev = i > 0 ? bucket[i - 1].frame : null;
      // 이전 온도: bucket 내 이전 frame 또는 직전 렌더 사이클의 마지막 온도
      const prevT = prev ? prev.temperature : prevTemp;

      // Temperature threshold crossing 감지
      if (prevT) {
        for (let ch = 0; ch < 2; ch++) {
          const was = prevT[ch];
          const now = f.temperature[ch];
          // WARN crossing (아래→위 또는 위→아래)
          if ((was < TEMP_WARN && now >= TEMP_WARN) || (was >= TEMP_WARN && now < TEMP_WARN)) {
            events.push(bucket[i]);
            bucket[i].frame = { ...f, isEvent: true, eventType: "temp_warn" };
            break;
          }
          // DANGER crossing
          if ((was < TEMP_DANGER && now >= TEMP_DANGER) || (was >= TEMP_DANGER && now < TEMP_DANGER)) {
            events.push(bucket[i]);
            bucket[i].frame = { ...f, isEvent: true, eventType: "temp_danger" };
            break;
          }
        }
      }
      // 이미 이벤트로 잡힌 frame은 skip
      if (bucket[i].frame.isEvent) continue;

      // Excursion peak 감지: 앞뒤 frame보다 절대값이 큰 극값
      if (prev && i < bucket.length - 1) {
        const next = bucket[i + 1].frame;
        for (let ch = 0; ch < 2; ch++) {
          const cur = Math.abs(f.excursion[ch]);
          if (cur > Math.abs(prev.excursion[ch]) && cur > Math.abs(next.excursion[ch])) {
            events.push(bucket[i]);
            bucket[i].frame = { ...f, isEvent: true, eventType: "exc_peak" };
            break;
          }
        }
      }
    }
    return events;
  }

  // ── Step 3: Render Scheduler — 33ms마다 큐를 drain하여 state update ─────
  useEffect(() => {
    if (!isPlaying) return;

    // 재생 시작 시 큐 관련 카운터 초기화
    outputQueueRef.current    = [];
    droppedFramesRef.current  = 0;
    renderTickCountRef.current = 0;
    sourceCountSumRef.current = 0;
    preservedEventsRef.current = 0;
    eventLogRef.current        = [];
    prevTempRef.current        = null;
    lastRenderRateRef.current = { time: performance.now(), count: 0 };
    renderUpdateRateRef.current = null;

    const timer = setInterval(() => {
      const bucket = outputQueueRef.current;
      outputQueueRef.current = [];

      if (bucket.length === 0) return;

      // Step 6: 이벤트 감지
      const eventFrames = detectEvents(bucket, prevTempRef.current);

      // Step 5: Coalescing 정책 — 요약 frame으로 병합
      const renderFrame = coalesceFrames(bucket);
      const latest = bucket[bucket.length - 1];

      // 직전 온도 기록 (다음 tick의 crossing 감지용)
      prevTempRef.current = latest.frame.temperature;

      // 렌더링할 frame 목록: 이벤트 frame + coalesced frame
      // 이벤트 frame은 coalesced의 latest와 중복될 수 있으므로 제거
      const renderFrames: AnalysisFrame[] = [];
      for (const ev of eventFrames) {
        if (ev !== latest) {
          renderFrames.push(ev.frame);
        }
      }
      renderFrames.push(renderFrame); // coalesced frame은 항상 마지막

      // 큐 메트릭 업데이트
      const preserved = renderFrames.length - 1; // coalesced 제외한 보존 이벤트 수
      preservedEventsRef.current += preserved;
      for (const ev of eventFrames) {
        if (ev !== latest && ev.frame.eventType) {
          eventLogRef.current.push({ audioTime: ev.frame.time, eventType: ev.frame.eventType });
        }
      }
      const dropped = bucket.length - renderFrames.length;
      droppedFramesRef.current += Math.max(0, dropped);
      renderTickCountRef.current++;
      sourceCountSumRef.current += bucket.length;

      // recv 시각은 실제 수신 시점 기록 (정확한 latency 측정)
      frameRecvAtRef.current = latest.recvAt;

      setStreamingFrames((prev) => {
        const next = [...prev, ...renderFrames];
        streamingLenRef.current = next.length;
        if (isMeasuringRef.current && next.length > maxStreamingLenRef.current) {
          maxStreamingLenRef.current = next.length;
        }
        return next.length > STREAM_WINDOW ? next.slice(-STREAM_WINDOW) : next;
      });

      // 렌더 업데이트 빈도 측정 (1초 윈도우)
      const now = performance.now();
      const rateCheck = lastRenderRateRef.current;
      if (now - rateCheck.time >= 1000) {
        renderUpdateRateRef.current = parseFloat(
          ((renderTickCountRef.current - rateCheck.count) / ((now - rateCheck.time) / 1000)).toFixed(1)
        );
        lastRenderRateRef.current = { time: now, count: renderTickCountRef.current };
      }
    }, RENDER_INTERVAL);

    return () => clearInterval(timer);
  }, [isPlaying]);

  // ── 디버그 업데이트 시 최신 rtt/srv 캐시 ────────────────────────────────
  const handleDebugUpdate = useCallback((info: Partial<StreamDebugInfo>) => {
    if (info.latestRttMs !== undefined)       { latestRttRef.current = info.latestRttMs; latestRttMsRef.current = info.latestRttMs; }
    if (info.serverProcessingMs !== undefined) latestSrvProcMsRef.current = info.serverProcessingMs;
    setDebugInfo((prev) => ({ ...prev, ...info }));
  }, []);

  // ── React 렌더 완료 콜백 (TemperatureChart useLayoutEffect에서 호출) ──────
  const handleReactRender = useCallback((ts: number) => {
    reactRenderAtRef.current = ts;
    const reactMs = parseFloat((ts - frameRecvAtRef.current).toFixed(2));
    setDebugInfo((prev) => ({ ...prev, reactRenderMs: reactMs }));
  }, []);

  // ── ECharts 렌더 완료 콜백 (TemperatureChart onEvents rendered에서 호출) ──
  const handleEchartsRender = useCallback((ts: number) => {
    const echartsMs      = parseFloat((ts - reactRenderAtRef.current).toFixed(2));
    const totalRecvMs    = parseFloat((ts - frameRecvAtRef.current).toFixed(2));
    const rtt            = latestRttRef.current;
    const totalE2eMs     = rtt !== null
      ? parseFloat((rtt + totalRecvMs).toFixed(2))
      : null;

    // freshness lag 계산: 현재 오디오 재생 시각 - 최신 렌더된 frame의 time
    const audioNow       = currentTimeRef.current;
    const renderedTime   = latestFrameTimeRef.current;
    const freshnessLagMs = audioNow > 0 && renderedTime > 0
      ? parseFloat(((audioNow - renderedTime) * 1000).toFixed(2))
      : null;

    const reactMs = parseFloat((reactRenderAtRef.current - frameRecvAtRef.current).toFixed(2));
    latestRenderMetrics.current = { reactMs, echartsMs, totalRecvMs, totalE2eMs };

    setDebugInfo((prev) => ({
      ...prev,
      reactRenderMs:     reactMs,
      echartsRenderMs:   echartsMs,
      totalRecvRenderMs: totalRecvMs,
      totalE2eMs,
      freshnessLagMs,
      streamingFramesLen: streamingLenRef.current,
      outputQueueLen:    outputQueueRef.current.length,
      sourceCount:       sourceCountSumRef.current > 0 && renderTickCountRef.current > 0
        ? parseFloat((sourceCountSumRef.current / renderTickCountRef.current).toFixed(1))
        : 0,
      droppedFrames:     droppedFramesRef.current,
      renderUpdateRate:  renderUpdateRateRef.current,
      preservedEvents:   preservedEventsRef.current,
    }));

    // ── 서버로 metrics 역전송 (METRICS_INTERVAL마다 1회) ─────────────────────
    metricsCountRef.current++;
    if (metricsCountRef.current % METRICS_INTERVAL === 0) {
      waveformRef.current?.sendMessage({
        type:              "metrics",
        frameIdx:          latestFrameIdxRef.current,
        audioTime:         latestAudioTimeRef.current,
        rttMs:             latestRttMsRef.current,
        serverProcMs:      latestSrvProcMsRef.current,
        reactRenderMs:     reactMs,
        echartsRenderMs:   echartsMs,
        totalRecvRenderMs: totalRecvMs,
        totalE2eMs,
      });
    }

    // 브라우저 콘솔 요약
    if (metricsCountRef.current % METRICS_INTERVAL === 0) {
      console.debug(
        `[Pipeline] RTT:${rtt?.toFixed(2) ?? "—"}ms` +
        ` | react:${reactMs}ms | echarts:${echartsMs}ms` +
        ` | recv→render:${totalRecvMs}ms | E2E:${totalE2eMs ?? "—"}ms`
      );
    }
  }, []);

  // ── 프레임 로그 엔트리 수집 ───────────────────────────────────────────────
  const handleDebugLog = useCallback((entry: DebugLogEntry) => {
    // 최신 frameIdx/audioTime 캐시
    latestFrameIdxRef.current  = entry.frameIdx;
    latestAudioTimeRef.current = entry.audioTime;
    // 직전 렌더 사이클의 render 타임을 첨부
    const m = latestRenderMetrics.current;
    // freshness lag 계산
    const audioNow     = currentTimeRef.current;
    const frameTime    = entry.audioTime;
    const freshLag     = audioNow > 0 && frameTime > 0
      ? parseFloat(((audioNow - frameTime) * 1000).toFixed(2))
      : null;
    const enriched: DebugLogEntry = {
      ...entry,
      reactRenderMs:     m.reactMs,
      echartsRenderMs:   m.echartsMs,
      totalRecvRenderMs: m.totalRecvMs,
      freshnessLagMs:    freshLag,
    };
    pendingLogsRef.current.push(enriched);
    // 측정 모드: 제한 없이 별도 버퍼에 누적
    if (isMeasuringRef.current) {
      measureLogsRef.current.push(enriched);
    }
  }, []);

  // ── 100ms마다 pending 로그 flush ──────────────────────────────────────────
  useEffect(() => {
    if (!showDebug) return;
    const timer = setInterval(() => {
      if (pendingLogsRef.current.length === 0) return;
      setDebugLogs((prev) => {
        const next = [...prev, ...pendingLogsRef.current];
        pendingLogsRef.current = [];
        return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next;
      });
    }, 100);
    return () => clearInterval(timer);
  }, [showDebug]);

  // ── 상태 변경 ─────────────────────────────────────────────────────────────
  const handleStatusChange = useCallback((s: AppStatus) => {
    setStatus(s);
    if (s === "error") {
      setErrorMsg("WebSocket 연결에 실패했습니다. 서버가 실행 중인지 확인해주세요.");
    }
  }, []);

  const isActive  = status === "playing" || status === "paused";

  return (
    <div id="dashboard-root" className="flex flex-col h-screen overflow-hidden">
      <Header />

      <main id="dashboard-main" className="flex-1 overflow-auto p-4 lg:p-6">
        <div id="dashboard-content" className="max-w-screen-xl mx-auto h-full flex flex-col gap-4">

          {/* Top row */}
          <div id="dashboard-top-row" className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div id="upload-section" className="md:col-span-2 space-y-3">
              {/* 입력 모드 탭 */}
              <div className="flex gap-1 text-xs font-mono">
                {(["file", "mic"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => handleInputModeChange(m)}
                    className={cn(
                      "px-2.5 py-1 rounded border transition-all",
                      inputMode === m
                        ? "bg-brand-blue text-white border-brand-blue"
                        : "text-iron-400 border-iron-200 hover:border-iron-400"
                    )}
                  >
                    {m === "file" ? "파일" : "마이크"}
                  </button>
                ))}
              </div>

              <div className="flex items-start gap-2">
                <div className="flex-1">
                  {inputMode === "file" ? (
                    <AudioUploader
                      status={status}
                      selectedFile={audioFile}
                      onFileSelected={handleFileSelected}
                      onReset={handleReset}
                    />
                  ) : (
                    <MicrophonePlayer
                      status={status}
                      onStatusChange={handleStatusChange}
                      onFrameReceived={handleFrameReceived}
                      onStreamStart={handleStreamStart}
                      onDebugUpdate={handleDebugUpdate}
                      onDebugLog={handleDebugLog}
                      inputParams={inputParams}
                    />
                  )}
                </div>
                <div className="flex flex-col gap-1.5 mt-1">
                  <button
                    onClick={() => setShowDebug((v) => !v)}
                    className={`px-2 py-1 rounded text-xs font-mono border transition-all ${
                      showDebug
                        ? "bg-[#0d1117] text-green-400 border-green-700"
                        : "bg-iron-50 text-iron-400 border-iron-200 hover:border-iron-400"
                    }`}
                    title="레이턴시 디버그 패널 토글"
                  >
                    {showDebug ? "DEBUG ON" : "DEBUG"}
                  </button>
                  <button
                    onClick={handleMeasureToggle}
                    className={`px-2 py-1 rounded text-xs font-mono border transition-all ${
                      isMeasuring
                        ? "bg-red-950 text-red-400 border-red-700 hover:bg-red-900 animate-pulse"
                        : "bg-iron-50 text-iron-400 border-iron-200 hover:border-iron-400"
                    }`}
                    title="측정 모드 — 시작/중지 및 JSON 다운로드"
                  >
                    {isMeasuring ? `■ ${measureFrameCount}fr` : "● REC"}
                  </button>
                </div>
              </div>
              {errorMsg && (
                <p id="error-message" className="error-message text-xs text-red-500 px-1">오류: {errorMsg}</p>
              )}
            </div>

            <StatusPanel status={status} result={null} currentTime={currentTime} />
          </div>

          {/* Input Parameters */}
          <InputParameters values={inputParams} onChange={setInputParams} />

          {/* Waveform player — 파일 모드에서만 */}
          {inputMode === "file" && (
            <WaveformPlayer
              ref={waveformRef}
              audioFile={audioFile}
              status={status}
              onTimeUpdate={(t: number) => { currentTimeRef.current = t; setCurrentTime(t); }}
              onStatusChange={handleStatusChange}
              onFrameReceived={handleFrameReceived}
              onStreamStart={handleStreamStart}
              onDebugUpdate={handleDebugUpdate}
              onDebugLog={handleDebugLog}
              inputParams={inputParams}
            />
          )}

          {/* 디버그 패널 */}
          {showDebug && (
            <DebugPanel
              info={debugInfo}
              logs={debugLogs}
              isMeasuring={isMeasuring}
              measureFrameCount={measureFrameCount}
              onMeasureToggle={handleMeasureToggle}
            />
          )}

          {/* 실시간 차트 */}
          <div id="charts-section" className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1 min-h-0">
            <TemperatureChart
              frames={streamingFrames}
              currentTime={currentTime}
              isActive={isActive}
              streaming
              onReactRender={handleReactRender}
              onEchartsRender={handleEchartsRender}
            />
            <ExcursionChart
              frames={streamingFrames}
              currentTime={currentTime}
              isActive={isActive}
              streaming
            />
          </div>

        </div>
      </main>
    </div>
  );
}
