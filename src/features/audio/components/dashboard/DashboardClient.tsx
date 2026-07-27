"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Sidebar from "@/shared/components/Sidebar";
import SegmentedControl from "@/shared/components/ui/SegmentedControl";
import SelectedFilePanel from "@/features/audio/components/dashboard/SelectedFilePanel";
import WaveformPlayer, { WaveformPlayerHandle } from "@/features/audio/components/player/WaveformPlayer";
import DuplexFilePlayer from "@/features/audio/components/player/DuplexFilePlayer";
import MicrophonePlayer, { type MicRecordingExport, type MicrophonePlayerHandle } from "@/features/audio/components/player/MicrophonePlayer";
import type { CaptureStreamListener } from "@/features/audio/components/player/capture/useCaptureSession";
import TemperatureChart from "@/features/audio/components/chart/TemperatureChart";
import ExcursionChart from "@/features/audio/components/chart/ExcursionChart";
import ChartDetailOverlay, { type DetailMetric } from "@/features/audio/components/chart/ChartDetailOverlay";
import { ProtectedComparePanel } from "@/features/audio/components/channel/ProtectedComparePanel";
import WorkspaceDrawer from "@/features/audio/components/workspace/WorkspaceDrawer";
import RecordsDrawer from "@/features/audio/components/workspace/RecordsDrawer";
import CalibrationDrawer from "@/features/audio/components/calibration/CalibrationDrawer";
import { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import type { SessionStatus } from "@/features/audio/lib/cache/workspace";
import { useCalibration } from "../calibration/CalibrationContext";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { clearFrameCache } from "@/features/audio/lib/cache/frame";
import { formatTime, splitFileName } from "@/shared/lib/utils";
import { putAudio, clearAudio } from "@/features/audio/lib/cache/audio-blob";
import { coalesceFrames } from "@/features/audio/lib/render/coalesce";
import { e2e } from "@/features/audio/lib/perf-e2e/collector";
import { detectEvents, DEFAULT_TEMP_WARN, DEFAULT_TEMP_DANGER, type TempThresholds } from "@/features/audio/lib/render/detect-events";
import type { QueuedFrame } from "@/features/audio/lib/render/types";
import { useFrameCachePersistence } from "@/features/audio/components/dashboard/hooks/useFrameCachePersistence";
import { useCtrlBToggle } from "@/shared/hooks/useCtrlBToggle";

interface DashboardPageProps {
  useQueue: boolean;
}

const RENDER_INTERVAL = 100;

function computeMeasurementSummary(
  frames: AnalysisFrame[],
  thresholds: TempThresholds,
): { peakTemp: number | null; peakExcursion: number | null; status: SessionStatus | null } {
  if (frames.length === 0) return { peakTemp: null, peakExcursion: null, status: null };
  let peakTemp = -Infinity;
  let peakExcursion = 0;
  for (const f of frames) {
    peakTemp = Math.max(peakTemp, f.temperature);
    peakExcursion = Math.max(peakExcursion, Math.abs(f.excursion));
  }
  const status: SessionStatus =
    peakTemp >= thresholds.danger ? "danger" : peakTemp >= thresholds.warn ? "warning" : "normal";
  return { peakTemp, peakExcursion, status };
}

export default function DashboardPage({ useQueue }: DashboardPageProps) {
  const [realtimeStatus, setRealtimeStatus]   = useState<AppStatus>("idle");
  const [audioFile, setAudioFile]             = useState<File | null>(null);
  const [currentTime, setCurrentTime]         = useState(0);
  const [audioDuration, setAudioDuration]     = useState<number | null>(null);
  const [streamingFrames, setStreamingFrames] = useState<AnalysisFrame[]>([]);

  const { values: calibration } = useCalibration();
  const { saveCurrent, pendingLocalFile, clearPendingLocalFile } = useWorkspace();
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
  const [inputMode, setInputMode] = useState<"file" | "mic">("file");

  const [isElectron, setIsElectron] = useState(false);
  useEffect(() => {
    setIsElectron(typeof window !== "undefined" && typeof window.audioCapture !== "undefined");
  }, []);

  const [detailChart, setDetailChart] = useState<DetailMetric | null>(null);

  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useCtrlBToggle(() => setSidebarCollapsed((prev) => !prev));

  const streamingFramesRef = useRef<AnalysisFrame[]>([]);
  // 엔진이 실제로 계산한 프레임 전부(useQueue 코얼레싱과 무관) — 저장/CSV·JSON export 전용.
  const allFramesRef       = useRef<AnalysisFrame[]>([]);
  const audioDurationRef   = useRef<number | null>(null);
  const fileNameRef        = useRef<string | null>(null);

  const realtimeWaveRef = useRef<WaveformPlayerHandle>(null);
  const micWaveRef = useRef<MicrophonePlayerHandle>(null);
  const getProtectedBlob = useCallback(
    () => (inputMode === "file" ? realtimeWaveRef.current?.exportProtectedAudio() : micWaveRef.current?.exportProtectedAudio()) ?? null,
    [inputMode],
  );

  const getChannelsBlob = useCallback(
    () => (inputMode === "file" ? realtimeWaveRef.current?.exportRecordedAudio() : micWaveRef.current?.exportRecordedAudio()) ?? null,
    [inputMode],
  );
  const subscribeChannelStream = useCallback(
    (fn: CaptureStreamListener) => {
      const handle = inputMode === "file" ? realtimeWaveRef.current : micWaveRef.current;
      return handle?.subscribeCaptureStream(fn) ?? (() => {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inputMode, isElectron],
  );
  const outputQueueRef       = useRef<QueuedFrame[]>([]);
  const prevTempRef          = useRef<number | null>(null);
  const thresholdsRef        = useRef<TempThresholds>({ warn: DEFAULT_TEMP_WARN, danger: DEFAULT_TEMP_DANGER });

  useEffect(() => { streamingFramesRef.current = streamingFrames; }, [streamingFrames]);
  useEffect(() => { audioDurationRef.current    = audioDuration;   }, [audioDuration]);

  useFrameCachePersistence({
    audioFile, realtimeStatus,
    streamingFramesRef, audioDurationRef, fileNameRef,
    setStreamingFrames, setAudioDuration, setAudioFile,
  });

  const handleSaveToWorkspace = useCallback(async () => {
    if (!audioFile) return;
    const frames = allFramesRef.current;
    if (frames.length === 0) return;
    const name = splitFileName(audioFile.name).stem || "Untitled";
    const recordedAudio = realtimeWaveRef.current?.exportRecordedAudio() ?? null;
    const protectedAudio = getProtectedBlob();
    const { peakTemp, peakExcursion, status } = computeMeasurementSummary(frames, tempThresholds);
    await saveCurrent({
      name,
      audioFileName: recordedAudio ? `${name}.wav` : audioFile.name,
      audioDuration: audioDurationRef.current,
      analysisMode:  "realtime",
      frames,
      audioBlob: recordedAudio ?? audioFile,
      audioType: recordedAudio ? "audio/wav" : audioFile.type,
      protectedAudioBlob: protectedAudio,
      peakTemp, peakExcursion, status,
    });
  }, [audioFile, saveCurrent, tempThresholds, getProtectedBlob]);

  const handleSaveMicRecording = useCallback(async (rec: MicRecordingExport) => {
    const stamp = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const name =
      `capture-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}` +
      `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}-${rec.channels}ch`;
    const frames = allFramesRef.current;
    const protectedAudio = getProtectedBlob();
    const { peakTemp, peakExcursion, status } = computeMeasurementSummary(frames, tempThresholds);
    await saveCurrent({
      name,
      audioFileName: `${name}.wav`,
      audioDuration: rec.durationSec,
      analysisMode:  "realtime",
      frames,
      audioBlob: rec.blob,
      audioType: "audio/wav",
      protectedAudioBlob: protectedAudio,
      peakTemp, peakExcursion, status,
    });
  }, [saveCurrent, tempThresholds, getProtectedBlob]);

  const resetAnalysisState = useCallback(() => {
    setAudioDuration(null);
    setStreamingFrames([]);
    allFramesRef.current = [];
    setCurrentTime(0);
    setRealtimeStatus("idle");
  }, []);

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

  const handleInputModeChange = useCallback((mode: "file" | "mic") => {
    setInputMode(mode);
    resetAnalysisState();
    clearFrameCache();
    void clearAudio();
  }, [resetAnalysisState]);

  const handleStreamStart = useCallback(() => {
    setStreamingFrames([]);
    allFramesRef.current   = [];
    outputQueueRef.current = [];
    prevTempRef.current    = null;
  }, []);

  const expParams    = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const LTTB_ENABLED  = expParams?.get("lttb") !== "0";
  const isPlaying = realtimeStatus === "playing";

  const handleFrameReceived = useCallback((frame: AnalysisFrame) => {
    allFramesRef.current.push(frame);
    if (useQueue) {
      outputQueueRef.current.push({ frame, recvAt: performance.now() });
    } else {
      e2e.markCommit();
      setStreamingFrames((prev) => [...prev, frame]);
    }
  }, [useQueue]);

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
      setStreamingFrames((prev) => [...prev, ...renderFrames]);
    };

    const timer = setInterval(drain, RENDER_INTERVAL);

    return () => {
      clearInterval(timer);
      drain();
    };
  }, [isPlaying, useQueue]);

  const handleRealtimeStatus = useCallback((s: AppStatus) => {
    setRealtimeStatus(s);
  }, []);

  const handleRealtimeTime = useCallback((t: number) => {
    setCurrentTime(t);
  }, []);

  const isActive = realtimeStatus === "playing" || realtimeStatus === "paused"
    || streamingFrames.length > 0;

  return (
    <div
      id="dashboard-root"
      className="flex flex-col lg:flex-row min-h-screen lg:h-screen lg:overflow-hidden"
    >
      <Sidebar
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
                <h2 className="m-0 text-xl font-bold text-iron-900">
                  {inputMode === "file" ? "Real-time Tracking" : "Microphone Input"}
                </h2>
                <p className="m-0 mt-1 text-[13px] text-iron-500 truncate">
                  {inputMode === "file"
                    ? audioFile
                      ? `${audioFile.name} · ${formatTime(audioDuration ?? 0)}`
                      : "Select an audio file from Workspace"
                    : realtimeStatus === "playing"
                      ? "Capturing microphone"
                      : "Mic Standby"}
                </p>
              </div>
              <SegmentedControl
                value={inputMode}
                onChange={handleInputModeChange}
                options={[
                  { value: "file", label: "File" },
                  { value: "mic", label: "Microphone" },
                ]}
                className="w-[208px]"
                aria-label="Input Source"
              />
            </div>

            {inputMode === "file" && !audioFile && <SelectedFilePanel />}

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
                    frames={streamingFrames}
                    currentTime={currentTime}
                    isActive={isActive}
                    streaming
                    audioDuration={audioDuration}
                    lttb={LTTB_ENABLED}
                    perfTrack
                    onExpand={() => setDetailChart("excursion")}
                  />
                </div>
                <div className="h-[264px] lg:h-auto lg:min-h-0 lg:flex-1">
                  <TemperatureChart
                    frames={streamingFrames}
                    currentTime={currentTime}
                    isActive={isActive}
                    streaming
                    audioDuration={audioDuration}
                    lttb={LTTB_ENABLED}
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

        {inputMode === "file" ? (
          isElectron ? (
            <DuplexFilePlayer
              ref={realtimeWaveRef}
              audioFile={audioFile}
              status={realtimeStatus}
              onTimeUpdate={handleRealtimeTime}
              onStatusChange={handleRealtimeStatus}
              onFrameReceived={handleFrameReceived}
              onStreamStart={handleStreamStart}
              inputParams={inputParams}
              onDurationReady={setAudioDuration}
              onSave={handleSaveToWorkspace}
              canSave={!!audioFile && streamingFrames.length > 0}
              onReset={handleReset}
              elevated={detailChart !== null}
            />
          ) : (
          <WaveformPlayer
            ref={realtimeWaveRef}
            audioFile={audioFile}
            status={realtimeStatus}
            onTimeUpdate={handleRealtimeTime}
            onStatusChange={handleRealtimeStatus}
            onFrameReceived={handleFrameReceived}
            onStreamStart={handleStreamStart}
            inputParams={inputParams}
            onDurationReady={setAudioDuration}
            onSave={handleSaveToWorkspace}
            canSave={!!audioFile && streamingFrames.length > 0}
            onReset={handleReset}
            elevated={detailChart !== null}
          />
          )
        ) : (
          <MicrophonePlayer
            ref={micWaveRef}
            status={realtimeStatus}
            onStatusChange={handleRealtimeStatus}
            onFrameReceived={handleFrameReceived}
            onStreamStart={handleStreamStart}
            onSaveRecording={handleSaveMicRecording}
            inputParams={inputParams}
            elevated={detailChart !== null}
          />
        )}
      </div>

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
          getChannelsBlob={getChannelsBlob}
          getProtectedBlob={getProtectedBlob}
          subscribeChannelStream={subscribeChannelStream}
          sourceFile={audioFile}
          onClose={() => setDetailChart(null)}
        />
      )}
    </div>
  );
}
