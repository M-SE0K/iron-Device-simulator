"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import Header from "@/components/Header";
import AudioUploader from "@/components/AudioUploader";
import WaveformPlayer, { WaveformPlayerHandle } from "@/components/WaveformPlayer";
import TemperatureChart from "@/components/TemperatureChart";
import ExcursionChart from "@/components/ExcursionChart";
import StatusPanel from "@/components/StatusPanel";
import { AppStatus, AnalysisFrame, StreamDebugInfo, DebugLogEntry, MeasurementExport } from "@/lib/types";
import DebugPanel from "@/components/DebugPanel";

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
  });
  const [showDebug, setShowDebug] = useState(false);
  const [debugLogs, setDebugLogs] = useState<DebugLogEntry[]>([]);

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

      const rttVals  = logs.map(l => l.rttMs).filter((v): v is number => v !== null);
      const srvVals  = logs.map(l => l.serverProcMs);
      const tempVals = logs.map(l => l.temperature);
      const excVals  = logs.map(l => l.excursion);
      const e2eVals  = logs
        .map(l => (l.rttMs !== null && l.totalRecvRenderMs !== null)
          ? parseFloat((l.rttMs + l.totalRecvRenderMs).toFixed(2))
          : null)
        .filter((v): v is number => v !== null);

      const data: MeasurementExport = {
        meta: {
          recordedAt:             new Date().toISOString(),
          audioFile:              audioFile?.name ?? null,
          measurementDurationSec: durationSec,
          frameCount:             logs.length,
        },
        summary: {
          rtt:         { avg: avg(rttVals),  min: safeMin(rttVals),  max: safeMax(rttVals)  },
          serverProc:  { avg: avg(srvVals)  },
          temperature: { avg: avg(tempVals) ?? 0, min: safeMin(tempVals) ?? 0, max: safeMax(tempVals) ?? 0 },
          excursion:   { avg: avg(excVals)  ?? 0, min: safeMin(excVals)  ?? 0, max: safeMax(excVals)  ?? 0 },
          e2e:         { avg: avg(e2eVals),  min: safeMin(e2eVals),  max: safeMax(e2eVals)  },
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

  const handleStreamStart = useCallback(() => {
    setStreamingFrames([]);
  }, []);

  // ── 프레임 수신 — 수신 시각 기록 후 state 업데이트 ───────────────────────
  const handleFrameReceived = useCallback((frame: AnalysisFrame) => {
    frameRecvAtRef.current = performance.now();
    setStreamingFrames((prev) => [...prev, frame]);
  }, []);

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

    const reactMs = parseFloat((reactRenderAtRef.current - frameRecvAtRef.current).toFixed(2));
    latestRenderMetrics.current = { reactMs, echartsMs, totalRecvMs, totalE2eMs };

    setDebugInfo((prev) => ({
      ...prev,
      reactRenderMs:     reactMs,
      echartsRenderMs:   echartsMs,
      totalRecvRenderMs: totalRecvMs,
      totalE2eMs,
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
    const enriched: DebugLogEntry = {
      ...entry,
      reactRenderMs:     m.reactMs,
      echartsRenderMs:   m.echartsMs,
      totalRecvRenderMs: m.totalRecvMs,
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

  const isPlaying = status === "playing";
  const isActive  = isPlaying || status === "paused";

  return (
    <div id="dashboard-root" className="flex flex-col h-screen overflow-hidden">
      <Header />

      <main id="dashboard-main" className="flex-1 overflow-auto p-4 lg:p-6">
        <div id="dashboard-content" className="max-w-screen-xl mx-auto h-full flex flex-col gap-4">

          {/* Top row */}
          <div id="dashboard-top-row" className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div id="upload-section" className="md:col-span-2 space-y-3">
              <div className="flex items-start gap-2">
                <div className="flex-1">
                  <AudioUploader
                    status={status}
                    selectedFile={audioFile}
                    onFileSelected={handleFileSelected}
                    onReset={handleReset}
                  />
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

          {/* Waveform player */}
          <WaveformPlayer
            ref={waveformRef}
            audioFile={audioFile}
            status={status}
            onTimeUpdate={setCurrentTime}
            onStatusChange={handleStatusChange}
            onFrameReceived={handleFrameReceived}
            onStreamStart={handleStreamStart}
            onDebugUpdate={handleDebugUpdate}
            onDebugLog={handleDebugLog}
          />

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
