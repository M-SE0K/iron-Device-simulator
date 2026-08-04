"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Activity, Menu, PanelLeftClose, PanelLeftOpen, ShieldAlert, Thermometer } from "lucide-react";
import Sidebar from "@/shared/components/Sidebar";
import SelectedFilePanel from "@/features/audio/components/dashboard/SelectedFilePanel";
import DuplexFilePlayer from "@/features/audio/components/player/DuplexFilePlayer";
import type { CaptureStreamListener, WaveformPlayerHandle } from "@/features/audio/components/player/capture/types";
import type { DrawerEntry } from "@/features/audio/components/channel/ChannelSelectDrawer";
import { useChannelWaveStreams } from "@/features/audio/components/channel/useChannelWaveStreams";
import WorkspaceDrawer from "@/features/audio/components/workspace/WorkspaceDrawer";
import RecordsDrawer from "@/features/audio/components/workspace/RecordsDrawer";
import CalibrationDrawer from "@/features/audio/components/calibration/CalibrationDrawer";
import DashboardViewGrid from "@/features/audio/components/dashboard/DashboardViewGrid";
import ViewDrawer from "@/features/audio/components/dashboard/ViewDrawer";
import {
  useDashboardView,
  parseViewChannelId,
  viewChannelId,
  VIEW_EXCURSION,
  VIEW_PROTECTED,
  VIEW_TEMPERATURE,
} from "@/features/audio/components/dashboard/hooks/useDashboardView";
import { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import { channelLabel, channelColor } from "@/features/audio/lib/render/channel-meta";
import { AnnotationStore } from "@/features/audio/lib/render/annotation-store";
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
  const subscribeChannelStream = useCallback(
    (fn: CaptureStreamListener) => realtimeWaveRef.current?.subscribeCaptureStream(fn) ?? (() => {}),
    [],
  );
  const outputQueueRef       = useRef<QueuedFrame[]>([]);
  const prevTempRef          = useRef<number | null>(null);
  const thresholdsRef        = useRef<TempThresholds>({ warn: DEFAULT_TEMP_WARN, danger: DEFAULT_TEMP_DANGER });

  // ── View 탭(대시보드 표시 차트 구성) ────────────────────────────────────────────────
  const { selected: viewSelected, toggle: toggleViewItem } = useDashboardView();
  const viewDrawerOpen = activeDrawer === "view";
  const wantedChannels = useMemo(
    () => Array.from(viewSelected)
      .map(parseViewChannelId)
      .filter((ch): ch is number => ch !== null)
      .sort((a, b) => a - b),
    [viewSelected],
  );

  // 채널 카드가 하나라도 선택돼 있거나 View 드로어가 열려 있는 동안 캡처 청크 스트림을
  // 구독한다 — 재생 중 채널을 새로 체크해도 세션 시작부터 지금까지가 즉시 백필된다.
  const { header: channelHeader, getStore: getWaveStore } = useChannelWaveStreams({
    wantedChannels,
    listen: viewDrawerOpen || wantedChannels.length > 0,
    probe: viewDrawerOpen,
    getChannelsSnapshot,
    subscribeChannelStream,
  });

  // View 드로어 항목 — 캡처 이력이 없으면 Calibration의 Capture Channels 설정값으로 채널
  // 목록을 미리 보여준다("세션 시작 전 custom"). 세션이 시작되면 실제 헤더의 채널 수가 우선.
  const knownChannelCount = useMemo(() => {
    if (channelHeader) return channelHeader.channels;
    const configured = Number(calibration.channels);
    return Number.isFinite(configured) && configured > 0 ? configured : 0;
  }, [channelHeader, calibration.channels]);

  const viewEntries = useMemo<DrawerEntry[]>(() => {
    const metricEntries: DrawerEntry[] = [
      { id: VIEW_PROTECTED,   section: "metric", name: "Protection Algorithm", role: "Before/After", color: "#F59E0B", icon: ShieldAlert },
      { id: VIEW_EXCURSION,   section: "metric", name: "Excursion",            role: "Displacement", color: "#10B981", icon: Activity },
      { id: VIEW_TEMPERATURE, section: "metric", name: "Temperature",          role: "Voice Coil",   color: "#0B4171", icon: Thermometer },
    ];
    const channelEntries: DrawerEntry[] = Array.from({ length: knownChannelCount }, (_, ch) => {
      const { name, role } = channelLabel(ch, { voltage: "V (Voltage)", current: "I (Current)", extended: "Extended" });
      return { id: viewChannelId(ch), section: "channel", name, role, color: channelColor(ch) };
    });
    return [...metricEntries, ...channelEntries];
  }, [knownChannelCount]);

  // 점 잇기 주석 스토어 — 차트/채널 카드 id별로 하나씩, 세션이 갈리면(새 재생/리셋) 데이터가
  // 바뀌므로 전부 비운다. 카드가 잠시 체크 해제됐다 돌아와도 같은 세션 안에서는 선이 유지된다.
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
    clearAnnotations();
    allFramesRef.current = [];
    setRealtimeStatus("idle");
  }, [chartStore, clearHasFrames, clearAnnotations]);

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
    clearAnnotations(); // 새 세션 = 새 데이터 — 이전 세션 위에 그린 선은 의미를 잃는다
    allFramesRef.current   = [];
    outputQueueRef.current = [];
    prevTempRef.current    = null;
  }, [chartStore, clearHasFrames, clearAnnotations]);

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
          {/* h-full이 아니라 min-h-full — 행이 2개를 넘으면(채널 카드 추가 등) 뷰포트보다
              길어져야 하고, 그때는 main의 overflow-y-auto가 스크롤을 맡는다. */}
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
              audioFile={audioFile}
              subscribeChannelStream={subscribeChannelStream}
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
        />
      </div>
    </div>
  );
}
