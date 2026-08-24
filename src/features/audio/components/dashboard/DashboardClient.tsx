"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { isIronPerfEnabled, recordPerfSample } from "@/shared/lib/iron-perf";
import { Activity, Menu, PanelLeftClose, PanelLeftOpen, ShieldAlert, Thermometer } from "lucide-react";
import Sidebar from "./Sidebar";
import SelectedFilePanel from "@/features/audio/components/dashboard/SelectedFilePanel";
import DuplexFilePlayer from "@/features/audio/components/player/DuplexFilePlayer";
import type { CaptureStreamListener, WaveformPlayerHandle } from "@/features/audio/components/player/capture/types";
import type { DrawerEntry } from "@/features/audio/components/channel/ChannelSelectDrawer";
import { useChannelWaveStreams } from "@/features/audio/components/channel/hooks/useChannelWaveStreams";
import WorkspaceDrawer from "@/features/audio/components/workspace/WorkspaceDrawer";
import RecordsDrawer from "@/features/audio/components/workspace/RecordsDrawer";
import CalibrationDrawer from "@/features/audio/components/calibration/CalibrationDrawer";
import LoopbackDrawer from "@/features/audio/components/loopback/LoopbackDrawer";
import DashboardViewGrid from "@/features/audio/components/dashboard/DashboardViewGrid";
import ViewDrawer from "@/features/audio/components/dashboard/ViewDrawer";
import {
  useDashboardView,
  parseViewChannelId,
  viewChannelId,
  VIEW_EXCURSION,
  VIEW_PROTECTED,
  VIEW_TEMPERATURE,
  PROTECTED_INPUT_L,
  PROTECTED_INPUT_R,
  PROTECTED_PROTECTED_L,
  PROTECTED_PROTECTED_R,
} from "@/features/audio/components/dashboard/hooks/useDashboardView";
import {
  COLOR_INPUT_L,
  COLOR_INPUT_R,
  COLOR_PROTECTED_L,
  COLOR_PROTECTED_R,
} from "@/features/audio/components/channel/ProtectedComparePanel";
import { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import { channelLabel, channelColor } from "@/features/audio/lib/render/channel-meta";
import { AnnotationStore } from "@/features/audio/lib/render/annotation-store";
import { useCalibration } from "../calibration/CalibrationContext";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { clearFrameCache } from "@/features/audio/lib/cache/frame";
import { formatTime, splitFileName } from "@/shared/lib/utils";
import { putAudio, clearAudio } from "@/features/audio/lib/cache/audio-blob";
import { coalesceFrames } from "@/features/audio/lib/render/coalesce";
import { FrameLog } from "@/features/audio/lib/frame-log";
import { ChartStore } from "@/features/audio/lib/render/chart-store";
import { detectEvents, DEFAULT_TEMP_WARN, DEFAULT_TEMP_DANGER, type TempThresholds } from "@/features/audio/lib/render/detect-events";
import { useFrameCachePersistence } from "@/features/audio/components/dashboard/hooks/useFrameCachePersistence";
import { useWorkspaceSave } from "@/features/audio/components/dashboard/hooks/useWorkspaceSave";
import { useCtrlBToggle } from "@/shared/hooks/useGlobalKey";
import { useActiveDrawer } from "@/features/audio/components/ActiveDrawerContext";

export default function DashboardPage() {
  const [realtimeStatus, setRealtimeStatus]   = useState<AppStatus>("idle");
  const [audioFile, setAudioFile]             = useState<File | null>(null);
  const [audioDuration, setAudioDuration]     = useState<number | null>(null);
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

  /* 스피커 open(온도 ≥ 500°C) 경고 오버레이 노출 여부. 세션이 다시 시작되거나 분석 상태가
   * 리셋되면 내려간다 — 새 재생은 깨끗한 차트로 시작해야 하므로. */
  const [speakerOpen, setSpeakerOpen] = useState(false);
  const handleSpeakerOpen = useCallback(() => setSpeakerOpen(true), []);

  const { values: calibration } = useCalibration();
  const { saveCurrent, pendingLocalFile, clearPendingLocalFile } = useWorkspace();
  const { active: activeDrawer, openDrawer } = useActiveDrawer();
  const inputParams = useMemo<InputParameterValues>(
    () => ({ ambientTemp: calibration.ambientTemp }),
    [calibration.ambientTemp],
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

  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useCtrlBToggle(() => setSidebarCollapsed((prev) => !prev));

  const frameLog           = useMemo(() => new FrameLog(), []);
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
  const getDecodedPlayback = useCallback(
    () => realtimeWaveRef.current?.getDecodedPlayback() ?? null,
    [],
  );
  const subscribeChannelStream = useCallback(
    (fn: CaptureStreamListener) => realtimeWaveRef.current?.subscribeCaptureStream(fn) ?? (() => {}),
    [],
  );
  const outputQueueRef       = useRef<AnalysisFrame[]>([]);
  const prevTempRef          = useRef<number | null>(null);
  const thresholdsRef        = useRef<TempThresholds>({ warn: DEFAULT_TEMP_WARN, danger: DEFAULT_TEMP_DANGER });

  const { selected: viewSelected, toggle: toggleViewItem } = useDashboardView();
  const viewDrawerOpen = activeDrawer === "view";
  const wantedChannels = useMemo(
    () => Array.from(viewSelected)
      .map(parseViewChannelId)
      .filter((ch): ch is number => ch !== null)
      .sort((a, b) => a - b),
    [viewSelected],
  );

  const { header: channelHeader, getStore: getWaveStore } = useChannelWaveStreams({
    wantedChannels,
    listen: viewDrawerOpen || wantedChannels.length > 0,
    probe: viewDrawerOpen,
    getChannelsSnapshot,
    subscribeChannelStream,
  });

  const knownChannelCount = useMemo(() => {
    if (channelHeader) return channelHeader.channels;
    const configured = Number(calibration.channels);
    return Number.isFinite(configured) && configured > 0 ? configured : 0;
  }, [channelHeader, calibration.channels]);

  const viewEntries = useMemo<DrawerEntry[]>(() => {
    const metricEntries: DrawerEntry[] = [
      { id: VIEW_PROTECTED,   section: "metric", name: "Protection Algorithm", role: "Before/After", color: "#F59E0B", icon: ShieldAlert },
      { id: PROTECTED_INPUT_L,      section: "metric", parentId: VIEW_PROTECTED, name: "Input L",     role: "Original",         color: COLOR_INPUT_L },
      { id: PROTECTED_INPUT_R,      section: "metric", parentId: VIEW_PROTECTED, name: "Input R",     role: "Original",         color: COLOR_INPUT_R },
      { id: PROTECTED_PROTECTED_L,  section: "metric", parentId: VIEW_PROTECTED, name: "Protected L", role: "After protection", color: COLOR_PROTECTED_L },
      { id: PROTECTED_PROTECTED_R,  section: "metric", parentId: VIEW_PROTECTED, name: "Protected R", role: "After protection", color: COLOR_PROTECTED_R },
      { id: VIEW_EXCURSION,   section: "metric", name: "Excursion",            role: "Displacement", color: "#10B981", icon: Activity },
      { id: VIEW_TEMPERATURE, section: "metric", name: "Temperature",          role: "Voice Coil",   color: "#0B4171", icon: Thermometer },
    ];
    const channelEntries: DrawerEntry[] = Array.from({ length: knownChannelCount }, (_, ch) => {
      const { name, role } = channelLabel(ch, { voltage: "V (Voltage)", current: "I (Current)", extended: "Extended" });
      return { id: viewChannelId(ch), section: "channel", name, role, color: channelColor(ch) };
    });
    return [...metricEntries, ...channelEntries];
  }, [knownChannelCount]);

  const annotationStoresRef = useRef<Map<string, AnnotationStore>>(new Map());
  const getAnnotationStore = useCallback((id: string): AnnotationStore => {
    let store = annotationStoresRef.current.get(id);
    if (!store) {
      store = new AnnotationStore();
      annotationStoresRef.current.set(id, store);
    }
    return store;
  }, []);
  const clearAnnotations = useCallback(() => {
    annotationStoresRef.current.forEach((store) => store.clear());
  }, []);

  useEffect(() => { audioDurationRef.current    = audioDuration;   }, [audioDuration]);

  useFrameCachePersistence({
    audioFile, realtimeStatus,
    chartStore, audioDurationRef, fileNameRef,
    onFramesRestored: markHasFrames, setAudioDuration, setAudioFile,
  });

  const saveWorkspace = useWorkspaceSave({
    frameLog,
    thresholds: tempThresholds,
    getProtectedBlob,
    saveCurrent,
  });

  const handleSaveToWorkspace = useCallback(async () => {
    if (!audioFile) return;
    if (frameLog.length === 0) return;
    const name = splitFileName(audioFile.name).stem || "Untitled";
    const recordedAudio = realtimeWaveRef.current?.exportRecordedAudio() ?? null;
    await saveWorkspace({
      name,
      audioDuration: audioDurationRef.current,
      source: { originalFile: audioFile, capturedAudio: recordedAudio },
    });
  }, [audioFile, frameLog, saveWorkspace]);

  const resetAnalysisState = useCallback(() => {
    setAudioDuration(null);
    chartStore.reset();
    clearHasFrames();
    clearAnnotations();
    frameLog.clear();
    setSpeakerOpen(false);
    setRealtimeStatus("idle");
  }, [chartStore, clearHasFrames, clearAnnotations, frameLog]);

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
    clearAnnotations();
    frameLog.clear();
    outputQueueRef.current = [];
    prevTempRef.current    = null;
    setSpeakerOpen(false);
  }, [chartStore, clearHasFrames, clearAnnotations, frameLog]);

  const isPlaying = realtimeStatus === "playing";

  const handleFrameReceived = useCallback((frame: AnalysisFrame) => {
    frameLog.push(frame);
    outputQueueRef.current.push(frame);
  }, [frameLog]);

  useEffect(() => {
    if (!isPlaying) return;

    outputQueueRef.current = [];
    prevTempRef.current    = null;

    const drain = () => {
      const bucket = outputQueueRef.current;
      outputQueueRef.current = [];

      if (bucket.length === 0) return;
      const drainT0 = performance.now();

      const eventFrames = detectEvents(bucket, prevTempRef.current, thresholdsRef.current);
      const renderFrame = coalesceFrames(bucket);
      const latest = bucket[bucket.length - 1];

      prevTempRef.current = latest.temperature;

      const renderFrames: AnalysisFrame[] = [];
      for (const ev of eventFrames) {
        if (ev !== latest) {
          renderFrames.push(ev);
        }
      }
      renderFrames.push(renderFrame);

      for (const f of renderFrames) chartStore.push(f);
      chartStore.flush();
      markHasFrames();
      recordPerfSample("render_drain", performance.now() - drainT0);
    };

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
  }, [isPlaying, chartStore, markHasFrames]);

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
          <div id="dashboard-content" className="lg:min-h-full w-full flex flex-col gap-4">
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

            <DashboardViewGrid
              selected={viewSelected}
              chartStore={chartStore}
              isActive={isActive}
              isPlaying={isPlaying}
              canAnnotateMetric={!isPlaying && hasFrames}
              audioDuration={audioDuration}
              tempThresholds={tempThresholds}
              speakerOpen={speakerOpen}
              audioFile={audioFile}
              subscribeChannelStream={subscribeChannelStream}
              getChannelsSnapshot={getChannelsSnapshot}
              getDecodedPlayback={getDecodedPlayback}
              getProtectedBlob={getProtectedBlob}
              channelHeader={channelHeader}
              getWaveStore={getWaveStore}
              getAnnotationStore={getAnnotationStore}
            />
          </div>
        </main>

        <ViewDrawer
          entries={viewEntries}
          selected={viewSelected}
          onToggle={toggleViewItem}
        />
        <WorkspaceDrawer />
        <RecordsDrawer />
        <CalibrationDrawer />
        {/* --dev 계측 빌드 전용 H/W 루프백 지연 측정 탭. 재생/일시정지 중에는 play-capture
          * IOProc이 장치를 점유하므로(pause도 캡처 유지) 실행을 막는다. */}
        {isIronPerfEnabled() && (
          <LoopbackDrawer sessionActive={realtimeStatus === "playing" || realtimeStatus === "paused"} />
        )}

        <DuplexFilePlayer
          ref={realtimeWaveRef}
          audioFile={audioFile}
          status={realtimeStatus}
          onStatusChange={handleRealtimeStatus}
          onFrameReceived={handleFrameReceived}
          onStreamStart={handleStreamStart}
          onSpeakerOpen={handleSpeakerOpen}
          inputParams={inputParams}
          onDurationReady={setAudioDuration}
          onSave={handleSaveToWorkspace}
          canSave={!!audioFile && hasFrames}
          onReset={handleReset}
        />
      </div>
    </div>
  );
}
