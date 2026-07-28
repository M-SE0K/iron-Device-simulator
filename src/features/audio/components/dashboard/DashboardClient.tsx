"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Sidebar from "@/shared/components/Sidebar";
import SelectedFilePanel from "@/features/audio/components/dashboard/SelectedFilePanel";
import WaveformPlayer, { WaveformPlayerHandle } from "@/features/audio/components/player/WaveformPlayer";
import DuplexFilePlayer from "@/features/audio/components/player/DuplexFilePlayer";
import type { CaptureStreamListener } from "@/features/audio/components/player/capture/types";
import TemperatureChart from "@/features/audio/components/chart/TemperatureChart";
import ExcursionChart from "@/features/audio/components/chart/ExcursionChart";
import ChartDetailOverlay, { type DetailMetric } from "@/features/audio/components/chart/ChartDetailOverlay";
import { ProtectedComparePanel } from "@/features/audio/components/channel/ProtectedComparePanel";
import WorkspaceDrawer from "@/features/audio/components/workspace/WorkspaceDrawer";
import RecordsDrawer from "@/features/audio/components/workspace/RecordsDrawer";
import CalibrationDrawer from "@/features/audio/components/calibration/CalibrationDrawer";
import { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import { useCalibration } from "../calibration/CalibrationContext";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { clearFrameCache } from "@/features/audio/lib/cache/frame";
import { formatTime, splitFileName } from "@/shared/lib/utils";
import { putAudio, clearAudio } from "@/features/audio/lib/cache/audio-blob";
import { coalesceFrames } from "@/features/audio/lib/render/coalesce";
import { ChartStore } from "@/features/audio/lib/render/chart-store";
import { e2e } from "@/features/audio/lib/perf-e2e/collector";
import { detectEvents, DEFAULT_TEMP_WARN, DEFAULT_TEMP_DANGER, type TempThresholds } from "@/features/audio/lib/render/detect-events";
import type { QueuedFrame } from "@/features/audio/lib/render/types";
import { useFrameCachePersistence } from "@/features/audio/components/dashboard/hooks/useFrameCachePersistence";
import { useWorkspaceSave } from "@/features/audio/components/dashboard/hooks/useWorkspaceSave";
import { useCtrlBToggle } from "@/shared/hooks/useCtrlBToggle";
import { useActiveDrawer } from "@/features/audio/components/dashboard/ActiveDrawerContext";

interface DashboardPageProps {
  useQueue: boolean;
}

export default function DashboardPage({ useQueue }: DashboardPageProps) {
  const [realtimeStatus, setRealtimeStatus]   = useState<AppStatus>("idle");
  const [audioFile, setAudioFile]             = useState<File | null>(null);
  const [audioDuration, setAudioDuration]     = useState<number | null>(null);
  /**
   * 차트 표시 데이터는 React 상태가 아니라 이 스토어가 소유한다 — 프레임이 도착해도
   * 리렌더가 일어나지 않고, 차트가 스토어를 구독해 uPlot에 직접 커밋한다. 대시보드가
   * 상태로 아는 건 "그릴 게 있는가"(hasFrames)뿐이라 세션당 한 번만 바뀐다.
   */
  const chartStore = useMemo(() => new ChartStore(), []);
  const [hasFrames, setHasFrames] = useState(false);
  const hasFramesRef = useRef(false);
  const markHasFrames = useCallback(() => {
    if (hasFramesRef.current) return;
    hasFramesRef.current = true;
    setHasFrames(true);
  }, []);
  const clearHasFrames = useCallback(() => {
    hasFramesRef.current = false;
    setHasFrames(false);
  }, []);

  const { values: calibration } = useCalibration();
  const { saveCurrent, pendingLocalFile, clearPendingLocalFile } = useWorkspace();
  const { active: activeDrawer, openDrawer, closeDrawer } = useActiveDrawer();
  const inputParams = useMemo<InputParameterValues>(
    () => ({
      ampOutputPower: calibration.ampOutputPower,
      speakerModel:   calibration.speakerModel,
      ambientTemp:    calibration.ambientTemp,
    }),
    [calibration.ampOutputPower, calibration.speakerModel, calibration.ambientTemp],
  );
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

  const [isElectron, setIsElectron] = useState(false);
  useEffect(() => {
    setIsElectron(typeof window !== "undefined" && typeof window.audioCapture !== "undefined");
  }, []);

  const [detailChart, setDetailChart] = useState<DetailMetric | null>(null);

  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useCtrlBToggle(() => setSidebarCollapsed((prev) => !prev));

  // 엔진이 실제로 계산한 프레임 전부(useQueue 코얼레싱·차트 감량과 무관) — 저장/CSV·JSON export 전용.
  const allFramesRef       = useRef<AnalysisFrame[]>([]);
  const audioDurationRef   = useRef<number | null>(null);
  const fileNameRef        = useRef<string | null>(null);

  const realtimeWaveRef = useRef<WaveformPlayerHandle>(null);
  const getProtectedBlob = useCallback(
    () => realtimeWaveRef.current?.exportProtectedAudio() ?? null,
    [],
  );

  const getChannelsSnapshot = useCallback(
    () => realtimeWaveRef.current?.getCaptureSnapshot() ?? null,
    [],
  );
  // isElectron이 바뀌면 파일 플레이어 구현(DuplexFilePlayer ↔ WaveformPlayer)이 통째로
  // 교체되면서 ref가 새 핸들을 가리키므로, 구독자들이 다시 구독하도록 deps에 남겨둔다.
  const subscribeChannelStream = useCallback(
    (fn: CaptureStreamListener) => realtimeWaveRef.current?.subscribeCaptureStream(fn) ?? (() => {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isElectron],
  );
  const outputQueueRef       = useRef<QueuedFrame[]>([]);
  const prevTempRef          = useRef<number | null>(null);
  const thresholdsRef        = useRef<TempThresholds>({ warn: DEFAULT_TEMP_WARN, danger: DEFAULT_TEMP_DANGER });

  useEffect(() => { audioDurationRef.current    = audioDuration;   }, [audioDuration]);

  useFrameCachePersistence({
    audioFile, realtimeStatus,
    chartStore, audioDurationRef, fileNameRef,
    onFramesRestored: markHasFrames, setAudioDuration, setAudioFile,
  });

  const saveWorkspace = useWorkspaceSave({
    framesRef: allFramesRef,
    thresholds: tempThresholds,
    getProtectedBlob,
    saveCurrent,
  });

  const handleSaveToWorkspace = useCallback(async () => {
    if (!audioFile) return;
    const frames = allFramesRef.current;
    if (frames.length === 0) return;
    const name = splitFileName(audioFile.name).stem || "Untitled";
    const recordedAudio = realtimeWaveRef.current?.exportRecordedAudio() ?? null;
    await saveWorkspace({
      name,
      audioDuration: audioDurationRef.current,
      source: { originalFile: audioFile, capturedAudio: recordedAudio },
    });
  }, [audioFile, saveWorkspace]);

  const resetAnalysisState = useCallback(() => {
    setAudioDuration(null);
    chartStore.reset();
    clearHasFrames();
    allFramesRef.current = [];
    setRealtimeStatus("idle");
  }, [chartStore, clearHasFrames]);

  const handleFileSelected = useCallback((file: File) => {
    setAudioFile(file);
    fileNameRef.current = file.name;
    resetAnalysisState();
    clearFrameCache();
    void putAudio(file);
  }, [resetAnalysisState]);

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
    void clearAudio();
  }, [resetAnalysisState]);

  const handleStreamStart = useCallback(() => {
    chartStore.reset();
    clearHasFrames();
    allFramesRef.current   = [];
    outputQueueRef.current = [];
    prevTempRef.current    = null;
  }, [chartStore, clearHasFrames]);

  const isPlaying = realtimeStatus === "playing";

  const handleFrameReceived = useCallback((frame: AnalysisFrame) => {
    allFramesRef.current.push(frame);
    if (useQueue) {
      outputQueueRef.current.push({ frame, recvAt: performance.now() });
    } else {
      e2e.markCommit();
      chartStore.push(frame);
      chartStore.flush();
      markHasFrames();
    }
  }, [useQueue, chartStore, markHasFrames]);

  useEffect(() => {
    if (!isPlaying) return;
    if (!useQueue) return;

    outputQueueRef.current = [];
    prevTempRef.current    = null;

    const drain = () => {
      const bucket = outputQueueRef.current;
      outputQueueRef.current = [];

      if (bucket.length === 0) return;

      if (e2e.isActive()) {
        const now = performance.now();
        for (const q of bucket) e2e.sample("N9", now - q.recvAt);
      }

      const { eventFrames, renderFrame } = e2e.time("N10", () => ({
        eventFrames: detectEvents(bucket, prevTempRef.current, thresholdsRef.current),
        renderFrame: coalesceFrames(bucket),
      }));
      const latest = bucket[bucket.length - 1];

      prevTempRef.current = latest.frame.temperature;

      const renderFrames: AnalysisFrame[] = [];
      for (const ev of eventFrames) {
        if (ev !== latest) {
          renderFrames.push(ev.frame);
        }
      }
      renderFrames.push(renderFrame);

      e2e.markCommit();
      for (const f of renderFrames) chartStore.push(f);
      chartStore.flush();
      markHasFrames();
    };

    // 데이터 도착 주기(약 10 ms)나 고정 타이머를 화면 주기와 직접 섞으면 60 Hz에서
    // 한 프레임 사이의 커밋 수가 3/3/4처럼 달라진다. 브라우저가 알려주는 실제 표시
    // 기회에 큐를 한 번만 비워 59.94/60/120 Hz 어느 모드에서도 커밋 cadence를 맞춘다.
    let renderRaf = 0;
    const renderTick = () => {
      drain();
      renderRaf = requestAnimationFrame(renderTick);
    };
    renderRaf = requestAnimationFrame(renderTick);

    return () => {
      cancelAnimationFrame(renderRaf);
      drain();
    };
  }, [isPlaying, useQueue, chartStore, markHasFrames]);

  const handleRealtimeStatus = useCallback((s: AppStatus) => {
    setRealtimeStatus(s);
  }, []);

  const isActive = realtimeStatus === "playing" || realtimeStatus === "paused"
    || hasFrames;

  return (
    <div
      id="dashboard-root"
      className="flex flex-col lg:flex-row min-h-screen lg:h-screen lg:overflow-hidden"
    >
      <Sidebar
        activeDrawer={activeDrawer}
        onOpenDrawer={openDrawer}
        onCloseDrawer={closeDrawer}
        mobileOpen={mobileNavOpen}
        onMobileClose={closeMobileNav}
        collapsed={sidebarCollapsed}
      />

      <div id="content-column" className="relative flex-1 min-w-0 flex flex-col lg:h-screen lg:overflow-hidden">
        <div
          className="lg:hidden flex items-center gap-3 px-4 border-b border-iron-100 bg-white shrink-0"
          style={{ paddingTop: "env(safe-area-inset-top)", height: "calc(3.5rem + env(safe-area-inset-top))" }}
        >
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open menu"
            className="flex items-center justify-center w-9 h-9 rounded-lg text-iron-600 hover:bg-iron-100"
          >
            <Menu className="w-5 h-5" />
          </button>
          <span className="text-iron-900 text-[15px] font-extrabold tracking-tight">IRON DEVICE</span>
        </div>

        <main id="dashboard-main" className="flex-1 min-h-0 overflow-y-auto p-3 lg:p-7 pb-28 lg:pb-32">
          <div id="dashboard-content" className="lg:h-full w-full flex flex-col gap-4">
            <div className="flex items-center gap-4 flex-wrap">
              <button
                type="button"
                onClick={() => setSidebarCollapsed((prev) => !prev)}
                aria-label={sidebarCollapsed ? "Expand sidebar (⌘/Ctrl + B)" : "Collapse sidebar (⌘/Ctrl + B)"}
                title={sidebarCollapsed ? "Expand sidebar (⌘/Ctrl + B)" : "Collapse sidebar (⌘/Ctrl + B)"}
                className="hidden lg:flex items-center justify-center w-8 h-8 rounded-lg text-iron-500 hover:bg-iron-100 hover:text-iron-700 transition-colors shrink-0"
              >
                {sidebarCollapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
              </button>
              <div className="mr-auto min-w-0">
                <h2 className="m-0 text-xl font-bold text-iron-900">Real-time Tracking</h2>
                <p className="m-0 mt-1 text-[13px] text-iron-500 truncate">
                  {audioFile
                    ? `${audioFile.name} · ${formatTime(audioDuration ?? 0)}`
                    : "Select an audio file from Workspace"}
                </p>
              </div>
            </div>

            {!audioFile && <SelectedFilePanel />}

            <div id="dashboard-grid" className="flex flex-col gap-4 lg:flex-1 lg:min-h-[528px]">
              <div id="protected-compare-section" className="h-[280px] shrink-0">
                <ProtectedComparePanel
                  subscribeCaptureStream={subscribeChannelStream}
                  sourceFile={audioFile}
                  getProtectedBlob={getProtectedBlob}
                />
              </div>
              <div id="charts-section" className="flex flex-col lg:flex-row gap-4 min-h-0 lg:flex-1">
                <div className="h-[264px] lg:h-auto lg:min-h-0 lg:flex-1">
                  <ExcursionChart
                    store={chartStore}
                    isActive={isActive}
                    streaming={isPlaying}
                    audioDuration={audioDuration}
                    perfTrack
                    onExpand={() => setDetailChart("excursion")}
                  />
                </div>
                <div className="h-[264px] lg:h-auto lg:min-h-0 lg:flex-1">
                  <TemperatureChart
                    store={chartStore}
                    isActive={isActive}
                    streaming={isPlaying}
                    audioDuration={audioDuration}
                    perfTrack
                    onExpand={() => setDetailChart("temperature")}
                    warnThreshold={tempThresholds.warn}
                    dangerThreshold={tempThresholds.danger}
                  />
                </div>
              </div>
            </div>
          </div>
        </main>

        <WorkspaceDrawer />
        <RecordsDrawer />
        <CalibrationDrawer />

        {isElectron ? (
          <DuplexFilePlayer
            ref={realtimeWaveRef}
            audioFile={audioFile}
            status={realtimeStatus}
            onStatusChange={handleRealtimeStatus}
            onFrameReceived={handleFrameReceived}
            onStreamStart={handleStreamStart}
            inputParams={inputParams}
            onDurationReady={setAudioDuration}
            onSave={handleSaveToWorkspace}
            canSave={!!audioFile && hasFrames}
            onReset={handleReset}
            elevated={detailChart !== null}
          />
        ) : (
          <WaveformPlayer
            ref={realtimeWaveRef}
            audioFile={audioFile}
            status={realtimeStatus}
            onStatusChange={handleRealtimeStatus}
            onFrameReceived={handleFrameReceived}
            onStreamStart={handleStreamStart}
            inputParams={inputParams}
            onDurationReady={setAudioDuration}
            onSave={handleSaveToWorkspace}
            canSave={!!audioFile && hasFrames}
            onReset={handleReset}
            elevated={detailChart !== null}
          />
        )}
      </div>

      {detailChart && (
        <ChartDetailOverlay
          metric={detailChart}
          store={chartStore}
          isActive={isActive}
          audioDuration={audioDuration}
          warnThreshold={tempThresholds.warn}
          dangerThreshold={tempThresholds.danger}
          getChannelsSnapshot={getChannelsSnapshot}
          getProtectedBlob={getProtectedBlob}
          subscribeChannelStream={subscribeChannelStream}
          sourceFile={audioFile}
          onClose={() => setDetailChart(null)}
        />
      )}
    </div>
  );
}
