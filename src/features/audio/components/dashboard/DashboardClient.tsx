"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import Header from "@/shared/components/Header";
import { AnalysisModeProvider } from "@/features/audio/components/dashboard/AnalysisModeContext";
import SelectedFilePanel from "@/features/audio/components/dashboard/SelectedFilePanel";
import WaveformPlayer, { WaveformPlayerHandle } from "@/features/audio/components/player/WaveformPlayer";
import MicrophonePlayer, { type MicRecordingExport } from "@/features/audio/components/player/MicrophonePlayer";
import TemperatureChart from "@/features/audio/components/chart/TemperatureChart";
import ExcursionChart from "@/features/audio/components/chart/ExcursionChart";
import ChartDetailOverlay, { type DetailMetric } from "@/features/audio/components/chart/ChartDetailOverlay";
import { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import { StreamDebugInfo, DebugLogEntry, MeasurementExport } from "@/features/audio/lib/debug/types";
import { useCalibration } from "../calibration/CalibrationContext";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { clearFrameCache } from "@/features/audio/lib/cache/frame";
import { putAudio, clearAudio } from "@/features/audio/lib/cache/audio-blob";
import { coalesceFrames } from "@/features/audio/lib/render/coalesce";
import { detectEvents, DEFAULT_TEMP_WARN, DEFAULT_TEMP_DANGER, type TempThresholds } from "@/features/audio/lib/render/detect-events";
import type { QueuedFrame } from "@/features/audio/lib/render/types";
import { useMeasurementCapture } from "@/features/audio/components/dashboard/hooks/useMeasurementCapture";
import { useRenderTelemetry } from "@/features/audio/components/dashboard/hooks/useRenderTelemetry";
import { useFrameCachePersistence } from "@/features/audio/components/dashboard/hooks/useFrameCachePersistence";

interface DashboardPageProps {
  useQueue: boolean;
}

export default function DashboardPage({ useQueue }: DashboardPageProps) {
  const [realtimeStatus, setRealtimeStatus]   = useState<AppStatus>("idle");
  const [audioFile, setAudioFile]             = useState<File | null>(null);
  const [currentTime, setCurrentTime]         = useState(0);
  const [audioDuration, setAudioDuration]     = useState<number | null>(null);
  const [errorMsg, setErrorMsg]               = useState<string | null>(null);
  // 실시간 분석 버퍼 — 슬라이딩 윈도우(RENDER_WINDOW로 상한). 파일/마이크 두 입력 모드가 공유한다.
  const [streamingFrames, setStreamingFrames] = useState<AnalysisFrame[]>([]);

  // 분석 파라미터는 캘리브레이션 단일 소스(Context)에서 가져온다 — 대시보드 내 InputParameters 카드 제거.
  const { values: calibration } = useCalibration();
  // 좌측 작업 영역 드로어와 공유하는 저장 세션 목록/액션 (workspace-context)
  const { saveCurrent, pendingLocalFile, clearPendingLocalFile } = useWorkspace();
  const inputParams = useMemo<InputParameterValues>(
    () => ({
      ampOutputPower: calibration.ampOutputPower,
      speakerModel:   calibration.speakerModel,
      ambientTemp:    calibration.ambientTemp,
    }),
    [calibration.ampOutputPower, calibration.speakerModel, calibration.ambientTemp],
  );
  // 온도 WARN/DANGER 임계값 — 차트 markLine과 detectEvents 이벤트 감지가 공유한다.
  // 파싱 실패(빈 문자열/NaN) 시 기본값(65/75°C)으로 fallback.
  const tempThresholds = useMemo<TempThresholds>(() => {
    const warn = Number(calibration.tempWarn);
    const danger = Number(calibration.tempDanger);
    return {
      warn: Number.isFinite(warn) ? warn : DEFAULT_TEMP_WARN,
      danger: Number.isFinite(danger) ? danger : DEFAULT_TEMP_DANGER,
    };
  }, [calibration.tempWarn, calibration.tempDanger]);
  useEffect(() => {
    thresholdsRef.current = tempThresholds;
  }, [tempThresholds]);
  const [inputMode, setInputMode] = useState<"file" | "mic">("file");

  // ── 차트 상세(자세히 보기) 뷰 — 어느 차트를 전체화면으로 열었는지 (null = 대시보드) ──
  const [detailChart, setDetailChart] = useState<DetailMetric | null>(null);

  // ── sessionStorage 캐시용 최신값 미러 refs ────────────────────────────────
  // 이벤트 핸들러(pagehide 등)에서 stale closure 없이 최신 버퍼를 읽기 위함.
  const streamingFramesRef = useRef<AnalysisFrame[]>([]);
  const audioDurationRef   = useRef<number | null>(null);
  const fileNameRef        = useRef<string | null>(null);

  // ── WaveformPlayer ref (sendMessage/exportRecordedAudio 접근용) ──────────
  const realtimeWaveRef = useRef<WaveformPlayerHandle>(null);
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
  const isMeasuringRef           = useRef(false);
  const measureLogsRef           = useRef<DebugLogEntry[]>([]);
  const measureStartTimeRef      = useRef<number>(0);
  const rawFramesRef             = useRef<{ time: number; temperature: [number, number]; excursion: [number, number] }[]>([]);
  const renderedFramesRef        = useRef<{ time: number; temperature: [number, number]; excursion: [number, number] }[]>([]);
  // 렌더 완료 시점 freshnessLag (handleEchartsRender에서 기록, per render tick)
  const renderFreshnessLogsRef   = useRef<number[]>([]);

  // ── freshness lag 계산용 refs ─────────────────────────────────────────────
  const currentTimeRef       = useRef(0);
  const latestFrameTimeRef   = useRef(0);
  // 측정 모드 중 streamingFrames 최대 길이 추적
  const maxStreamingLenRef   = useRef(0);
  // streamingFrames 길이 추적 (useCallback 의존성 회피)
  const streamingLenRef      = useRef(0);

  // ── Step 3: Output Queue ────────────────────────────────────────────────
  const outputQueueRef       = useRef<QueuedFrame[]>([]);
  const droppedFramesRef     = useRef(0);
  const renderTickCountRef   = useRef(0);
  const sourceCountSumRef    = useRef(0);
  const preservedEventsRef   = useRef(0);
  const eventLogRef          = useRef<{ audioTime: number; eventType: "temp_warn" | "temp_danger" | "exc_peak" }[]>([]);
  // Step 6: 직전 렌더 frame의 temperature (threshold crossing 감지용)
  const prevTempRef          = useRef<[number, number] | null>(null);
  // Calibration.tempWarn/tempDanger — Render Scheduler(setInterval)가 effect 재실행 없이
  // 최신값을 읽도록 ref로 미러링한다(변경 시 outputQueueRef 등 카운터를 리셋하지 않기 위해
  // 의도적으로 스케줄러 effect의 deps에는 넣지 않는다).
  const thresholdsRef        = useRef<TempThresholds>({ warn: DEFAULT_TEMP_WARN, danger: DEFAULT_TEMP_DANGER });
  // 렌더 업데이트 빈도 측정
  const lastRenderRateRef    = useRef<{ time: number; count: number }>({ time: 0, count: 0 });
  const renderUpdateRateRef  = useRef<number | null>(null);

  // ── 렌더 파이프라인 측정용 refs ──────────────────────────────────────────
  // 프레임 수신 시각 (WaveformPlayer → DashboardClient handoff 시점)
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

  // ── JSON 다운로드 헬퍼 ────────────────────────────────────────────────────
  const downloadJson = useCallback((obj: unknown, filename: string) => {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  // ── 측정 모드 토글 + JSON 다운로드 (내부 측정 하네스 전용) ────────────────
  const { handleMeasureToggle } = useMeasurementCapture({
    isMeasuring, setIsMeasuring, setMeasureFrameCount,
    isMeasuringRef, measureLogsRef, measureStartTimeRef, rawFramesRef, renderedFramesRef,
    renderFreshnessLogsRef, maxStreamingLenRef, droppedFramesRef, renderTickCountRef,
    sourceCountSumRef, preservedEventsRef, eventLogRef, audioFile, downloadJson,
  });

  // ── 캐시 미러 refs 동기화 (이벤트 핸들러에서 최신값 읽기용) ───────────────
  useEffect(() => { streamingFramesRef.current = streamingFrames; }, [streamingFrames]);
  useEffect(() => { audioDurationRef.current    = audioDuration;   }, [audioDuration]);

  // ── sessionStorage 프레임 캐시 + IndexedDB 오디오 복원 (F5/탭 전환 대응) ──────
  const { persistCache } = useFrameCachePersistence({
    audioFile, realtimeStatus,
    streamingFramesRef, audioDurationRef, fileNameRef,
    setStreamingFrames, setAudioDuration, setAudioFile,
  });

  // ── 작업 영역(Workspace) 저장 — 현재 음원 + 실시간 분석 그래프를 영구 보존 ──────
  // 오디오는 원본 업로드 파일 전체가 아니라, 재생 중 캡처 세션이 실제로 분석한 신호(V/I)를
  // WAV로 인코딩해 저장한다(exportRecordedAudio) — 캡처된 적 없으면 원본 파일로 폴백한다.
  const handleSaveToWorkspace = useCallback(async () => {
    if (!audioFile) return;
    const frames = streamingFramesRef.current;
    if (frames.length === 0) return;
    const name = audioFile.name.replace(/\.[^./]+$/, "") || "Untitled";
    const recordedAudio = realtimeWaveRef.current?.exportRecordedAudio() ?? null;
    await saveCurrent({
      name,
      audioFileName: recordedAudio ? `${name}.wav` : audioFile.name,
      audioDuration: audioDurationRef.current,
      analysisMode:  "realtime",
      frames,
      audioBlob: recordedAudio ?? audioFile,
      audioType: recordedAudio ? "audio/wav" : audioFile.type,
    });
  }, [audioFile, saveCurrent]);

  // ── 마이크(네이티브 캡처) 녹음 저장 — 전 채널 WAV + 실시간 분석 그래프를 워크스페이스에 보존 ──
  // 오디오는 엔진에 나간 ch0(V)/ch1(I)만이 아니라 Calibration에서 지정한 채널 수 전체가
  // 담긴 N채널 WAV(캡처 세션 버퍼)다. 분석 프레임은 realtime 버퍼를 그대로 싣는다.
  const handleSaveMicRecording = useCallback(async (rec: MicRecordingExport) => {
    const stamp = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const name =
      `capture-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}` +
      `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}-${rec.channels}ch`;
    await saveCurrent({
      name,
      audioFileName: `${name}.wav`,
      audioDuration: rec.durationSec,
      analysisMode:  "realtime",
      frames: streamingFramesRef.current,
      audioBlob: rec.blob,
      audioType: "audio/wav",
    });
  }, [saveCurrent]);

  // ── 파일 선택 / 초기화 ────────────────────────────────────────────────────
  // 모든 분석 버퍼/상태를 새 음원 기준으로 비우는 공통 루틴 (캐시 I/O 제외)
  const resetAnalysisState = useCallback(() => {
    setAudioDuration(null);
    setStreamingFrames([]);
    setCurrentTime(0);
    setRealtimeStatus("idle");
    setErrorMsg(null);
    isMeasuringRef.current = false;
    setIsMeasuring(false);
    measureLogsRef.current = [];
    setMeasureFrameCount(0);
  }, []);

  const handleFileSelected = useCallback((file: File) => {
    setAudioFile(file);
    fileNameRef.current = file.name;
    resetAnalysisState();
    clearFrameCache();
    void putAudio(file); // 새로고침 후 파형 복원용으로 오디오 원본을 IndexedDB에 저장
  }, [resetAnalysisState]);

  // 워크스페이스 드로어의 "로컬 폴더"에서 파일을 고르면 WorkspaceContext가
  // pendingLocalFile로 밀어준다 — 기존 업로드 파이프라인(handleFileSelected)에 그대로 흘려보낸다.
  useEffect(() => {
    if (!pendingLocalFile) return;
    handleFileSelected(pendingLocalFile);
    clearPendingLocalFile();
  }, [pendingLocalFile, handleFileSelected, clearPendingLocalFile]);

  const handleReset = useCallback(() => {
    setAudioFile(null);
    fileNameRef.current = null;
    resetAnalysisState();
    clearFrameCache();
    void clearAudio(); // 캐시된 오디오 원본도 제거
  }, [resetAnalysisState]);

  const handleInputModeChange = useCallback((mode: "file" | "mic") => {
    setInputMode(mode);
    setAudioDuration(null);
    setStreamingFrames([]);
    clearFrameCache();
    void clearAudio();
    setCurrentTime(0);
    setRealtimeStatus("idle");
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

  // ── 렌더 윈도우 (저장/렌더 분리) ─────────────────────────────────────────
  // 실시간 스트리밍 상태(streamingFrames)는 최근 RENDER_WINDOW 프레임만 유지한다.
  // 이렇게 하면 매 렌더 틱의 배열 복사·차트 map()·ECharts setOption 비용이
  // 곡 길이와 무관하게 상수로 묶이고, freshness 중심의 슬라이딩 윈도우 뷰가 된다.
  // ~62Hz 코얼레싱 기준 3000 ≈ 약 48초의 최근 구간.
  // ── 실험 토글: URL 쿼리로 제어 (측정 A/B용, 재빌드 불필요) ───────────────
  //   ?win=200000 → RENDER_WINDOW(버퍼 상한), ?lttb=0 → 차트 LTTB 끔
  //   미지정 시 기본값(win=3000, lttb=on) = 프로덕션 동작.
  const expParams    = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const RENDER_WINDOW = expParams?.get("win") ? Math.max(1, parseInt(expParams.get("win")!, 10) || 3000) : 3000;
  const LTTB_ENABLED  = expParams?.get("lttb") !== "0";
  // ── Step 3: Render Scheduler 주기 (ms) ──────────────────────────────────
  const RENDER_INTERVAL = 16;
  // 출력 큐 스케줄러는 실시간 스트리밍 경로(파일 재생+캡처 / 마이크)에서만 동작
  const isPlaying = realtimeStatus === "playing";

  // ── 프레임 수신 — useQueue 모드에 따라 큐 push 또는 FIFO append ────────
  const handleFrameReceived = useCallback((frame: AnalysisFrame) => {
    latestFrameTimeRef.current = frame.time;
    if (isMeasuringRef.current) {
      rawFramesRef.current.push({
        time:        frame.time,
        temperature: frame.temperature,
        excursion:   frame.excursion,
      });
    }
    if (useQueue) {
      outputQueueRef.current.push({ frame, recvAt: performance.now() });
    } else {
      // FIFO baseline: 수신 즉시 state append
      frameRecvAtRef.current = performance.now();
      if (isMeasuringRef.current) {
        renderedFramesRef.current.push({
          time:        frame.time,
          temperature: frame.temperature,
          excursion:   frame.excursion,
        });
      }
      setStreamingFrames((prev) => {
        const next = [...prev, frame];
        streamingLenRef.current = next.length;
        if (isMeasuringRef.current && next.length > maxStreamingLenRef.current) {
          maxStreamingLenRef.current = next.length;
        }
        return next.length > RENDER_WINDOW ? next.slice(-RENDER_WINDOW) : next;
      });
    }
  }, [useQueue]);

  // ── Step 3: Render Scheduler — 16ms마다 큐를 drain하여 state update ─────
  useEffect(() => {
    if (!isPlaying) return;
    if (!useQueue) return; // FIFO 모드: 스케줄러 불필요

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
      const eventFrames = detectEvents(bucket, prevTempRef.current, thresholdsRef.current);

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

      if (isMeasuringRef.current) {
        for (const rf of renderFrames) {
          renderedFramesRef.current.push({
            time:        rf.time,
            temperature: rf.temperature,
            excursion:   rf.excursion,
          });
        }
      }

      setStreamingFrames((prev) => {
        const next = [...prev, ...renderFrames];
        streamingLenRef.current = next.length;
        if (isMeasuringRef.current && next.length > maxStreamingLenRef.current) {
          maxStreamingLenRef.current = next.length;
        }
        return next.length > RENDER_WINDOW ? next.slice(-RENDER_WINDOW) : next;
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
  }, [isPlaying, useQueue]);

  // ── 렌더 파이프라인 텔레메트리(RTT/react/echarts/freshness lag 집계 + metrics 역전송) ──
  const { handleDebugUpdate, handleReactRender, handleEchartsRender, handleDebugLog } = useRenderTelemetry({
    realtimeWaveRef, frameRecvAtRef, reactRenderAtRef, latestRttRef, latestRenderMetrics,
    metricsCountRef, METRICS_INTERVAL, latestFrameIdxRef, latestAudioTimeRef,
    latestRttMsRef, latestSrvProcMsRef, currentTimeRef, latestFrameTimeRef,
    isMeasuringRef, renderFreshnessLogsRef, measureLogsRef,
  });

  // ── 상태 변경 ─────────────────────────────────────────────────────────────
  const handleRealtimeStatus = useCallback((s: AppStatus) => {
    setRealtimeStatus(s);
    if (s === "error") setErrorMsg("WebSocket 연결에 실패했습니다. 서버가 실행 중인지 확인해주세요.");
  }, []);

  // ── 재생 시각 갱신 ────────────────────────────────────────────────────────
  const handleRealtimeTime = useCallback((t: number) => {
    currentTimeRef.current = t;
    setCurrentTime(t);
  }, []);

  // 재생 중이거나, 표시할 캐시 프레임이 있으면 active (새로고침 후 캐시 복원 시에도 표시)
  const isActive = realtimeStatus === "playing" || realtimeStatus === "paused"
    || streamingFrames.length > 0;

  return (
    <AnalysisModeProvider
      value={{
        inputMode,
        setInputMode: handleInputModeChange,
      }}
    >
    <div
      id="dashboard-root"
      className="flex flex-col min-h-screen lg:h-screen lg:overflow-hidden"
    >
      <Header />

      <main id="dashboard-main" className="flex-1 min-h-0 overflow-y-auto p-3">
        <div id="dashboard-content" className="lg:h-full w-full flex flex-col gap-3">
          <div id="dashboard-grid" className="grid grid-cols-1 lg:grid-cols-2 gap-3 lg:flex-1 lg:min-h-[600px]">
            <div id="left-column" className="flex flex-col gap-3 min-h-0">
              <div id="upload-section" className="h-[220px] lg:h-auto lg:min-h-0 lg:flex-[2] flex flex-col gap-2">
                <div className="flex-1 min-h-0 min-w-0">
                  {inputMode === "file" ? (
                    <SelectedFilePanel
                      status={realtimeStatus}
                      selectedFile={audioFile}
                      onReset={handleReset}
                      onSave={handleSaveToWorkspace}
                      canSave={!!audioFile && streamingFrames.length > 0}
                    />
                  ) : (
                    <MicrophonePlayer
                      status={realtimeStatus}
                      onStatusChange={handleRealtimeStatus}
                      onFrameReceived={handleFrameReceived}
                      onStreamStart={handleStreamStart}
                      onDebugUpdate={handleDebugUpdate}
                      onDebugLog={handleDebugLog}
                      onSaveRecording={handleSaveMicRecording}
                      inputParams={inputParams}
                    />
                  )}
                </div>
                {errorMsg && (
                  <p id="error-message" className="error-message text-xs text-red-500 px-1 shrink-0">오류: {errorMsg}</p>
                )}
              </div>
              {inputMode === "file" && (
                <div className="h-[260px] lg:h-auto lg:min-h-0 lg:flex-[3]">
                  <WaveformPlayer
                    ref={realtimeWaveRef}
                    audioFile={audioFile}
                    status={realtimeStatus}
                    onTimeUpdate={handleRealtimeTime}
                    onStatusChange={handleRealtimeStatus}
                    onFrameReceived={handleFrameReceived}
                    onStreamStart={handleStreamStart}
                    onDebugUpdate={handleDebugUpdate}
                    onDebugLog={handleDebugLog}
                    inputParams={inputParams}
                    onDurationReady={setAudioDuration}
                  />
                </div>
              )}
            </div>
            <div id="charts-section" className="flex flex-col gap-3 min-h-0">
              <div className="h-[300px] lg:h-auto lg:min-h-0 lg:flex-1">
                <TemperatureChart
                  frames={streamingFrames}
                  currentTime={currentTime}
                  isActive={isActive}
                  streaming
                  audioDuration={audioDuration}
                  lttb={LTTB_ENABLED}
                  onReactRender={handleReactRender}
                  onEchartsRender={handleEchartsRender}
                  onExpand={() => setDetailChart("temperature")}
                  warnThreshold={tempThresholds.warn}
                  dangerThreshold={tempThresholds.danger}
                />
              </div>
              <div className="h-[300px] lg:h-auto lg:min-h-0 lg:flex-1">
                <ExcursionChart
                  frames={streamingFrames}
                  currentTime={currentTime}
                  isActive={isActive}
                  streaming
                  audioDuration={audioDuration}
                  lttb={LTTB_ENABLED}
                  onExpand={() => setDetailChart("excursion")}
                />
              </div>
            </div>

          </div>

        </div>
      </main>

      {/* 차트 상세(자세히 보기) 오버레이 — 라이브 데이터를 그대로 재사용해 재생 중에도 갱신 */}
      {detailChart && (
        <ChartDetailOverlay
          metric={detailChart}
          frames={streamingFrames}
          currentTime={currentTime}
          isActive={isActive}
          audioDuration={audioDuration}
          lttb={LTTB_ENABLED}
          warnThreshold={tempThresholds.warn}
          dangerThreshold={tempThresholds.danger}
          onClose={() => setDetailChart(null)}
        />
      )}
    </div>
    </AnalysisModeProvider>
  );
}
