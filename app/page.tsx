"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import Header from "@/components/Header";
import AudioUploader from "@/components/AudioUploader";
import WaveformPlayer from "@/components/WaveformPlayer";
import TemperatureChart from "@/components/TemperatureChart";
import ExcursionChart from "@/components/ExcursionChart";
import StatusPanel from "@/components/StatusPanel";
import { AppStatus, AnalysisFrame, StreamDebugInfo, DebugLogEntry } from "@/lib/types";
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
  });
  const [showDebug, setShowDebug]     = useState(false);
  const [debugLogs, setDebugLogs]     = useState<DebugLogEntry[]>([]);
  // 프레임마다 setState 호출 방지 — ref에 누적 후 100ms마다 flush
  const pendingLogsRef = useRef<DebugLogEntry[]>([]);
  const MAX_LOG_ENTRIES = 500;

  // 파일 선택
  const handleFileSelected = useCallback((file: File) => {
    setAudioFile(file);
    setStreamingFrames([]);
    setDebugLogs([]);
    pendingLogsRef.current = [];
    setCurrentTime(0);
    setStatus("idle");
    setErrorMsg(null);
  }, []);

  // 초기화
  const handleReset = useCallback(() => {
    setAudioFile(null);
    setStreamingFrames([]);
    setDebugLogs([]);
    pendingLogsRef.current = [];
    setCurrentTime(0);
    setStatus("idle");
    setErrorMsg(null);
  }, []);

  // 스트리밍 시작 — 누적 프레임 초기화
  const handleStreamStart = useCallback(() => {
    setStreamingFrames([]);
  }, []);

  // 디버그 메트릭 업데이트 (Partial merge)
  const handleDebugUpdate = useCallback((info: Partial<StreamDebugInfo>) => {
    setDebugInfo((prev) => ({ ...prev, ...info }));
  }, []);

  // 프레임 로그 엔트리 수집 (ref에만 push — flush는 아래 interval에서)
  const handleDebugLog = useCallback((entry: DebugLogEntry) => {
    pendingLogsRef.current.push(entry);
  }, []);

  // 100ms마다 pending 로그를 state에 flush (debug 패널이 열릴 때만)
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

  // WebSocket에서 수신된 프레임 append
  const handleFrameReceived = useCallback((frame: AnalysisFrame) => {
    setStreamingFrames((prev) => [...prev, frame]);
  }, []);

  // 상태 변경 (error 처리 포함)
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

          {/* Top row: uploader + status */}
          <div id="dashboard-top-row" className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Upload */}
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
                <button
                  onClick={() => setShowDebug((v) => !v)}
                  className={`mt-1 px-2 py-1 rounded text-xs font-mono border transition-all ${
                    showDebug
                      ? "bg-[#0d1117] text-green-400 border-green-700"
                      : "bg-iron-50 text-iron-400 border-iron-200 hover:border-iron-400"
                  }`}
                  title="레이턴시 디버그 패널 토글"
                >
                  {showDebug ? "DEBUG ON" : "DEBUG"}
                </button>
              </div>
              {errorMsg && (
                <p id="error-message" className="error-message text-xs text-red-500 px-1">오류: {errorMsg}</p>
              )}
            </div>

            {/* Status panel */}
            <StatusPanel
              status={status}
              result={null}
              currentTime={currentTime}
            />
          </div>

          {/* Waveform player — 내부에서 WS 연결 + rAF 루프 관리 */}
          <WaveformPlayer
            audioFile={audioFile}
            status={status}
            onTimeUpdate={setCurrentTime}
            onStatusChange={handleStatusChange}
            onFrameReceived={handleFrameReceived}
            onStreamStart={handleStreamStart}
            onDebugUpdate={handleDebugUpdate}
            onDebugLog={handleDebugLog}
          />

          {/* 레이턴시 디버그 패널 */}
          {showDebug && <DebugPanel info={debugInfo} logs={debugLogs} />}

          {/* 실시간 차트 (스트리밍 프레임 사용) */}
          <div id="charts-section" className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1 min-h-0">
            <TemperatureChart
              frames={streamingFrames}
              currentTime={currentTime}
              isActive={isActive}
              streaming
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
