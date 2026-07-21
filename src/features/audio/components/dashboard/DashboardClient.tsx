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
import { detectEvents, DEFAULT_TEMP_WARN, DEFAULT_TEMP_DANGER, type TempThresholds } from "@/features/audio/lib/render/detect-events";
import type { QueuedFrame } from "@/features/audio/lib/render/types";
import { useFrameCachePersistence } from "@/features/audio/components/dashboard/hooks/useFrameCachePersistence";

interface DashboardPageProps {
  useQueue: boolean;
}

// ── Step 3: Render Scheduler 주기 (ms) ──────────────────────────────────────
const RENDER_INTERVAL = 16;

// 측정 기록(사이드바 "측정 기록" 드로어)용 — 저장 시점에 프레임 버퍼에서 Peak 온도/진폭과
// WARN/DANGER 임계값 기준 상태를 한 번만 계산해 워크스페이스 아이템에 함께 저장한다.
function computeMeasurementSummary(
  frames: AnalysisFrame[],
  thresholds: TempThresholds,
): { peakTemp: number | null; peakExcursion: number | null; status: SessionStatus | null } {
  if (frames.length === 0) return { peakTemp: null, peakExcursion: null, status: null };
  let peakTemp = -Infinity;
  let peakExcursion = 0;
  for (const f of frames) {
    peakTemp = Math.max(peakTemp, f.temperature[0], f.temperature[1]);
    peakExcursion = Math.max(peakExcursion, Math.abs(f.excursion[0]), Math.abs(f.excursion[1]));
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
  const [errorMsg, setErrorMsg]               = useState<string | null>(null);
  // 실시간 분석 버퍼 — 0초부터 전체 이력 유지(상한 없음). 파일/마이크 두 입력 모드가 공유한다.
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

  // Electron(네이티브 브리지 존재) 파일 모드는 항상 duplex 플레이어(play-capture 단일
  // IOProc) — useCaptureSession의 경로 선택과 같은 감지 기준. 정적 export의 hydration
  // 불일치를 피하려고 마운트 후 effect에서 판정한다(서버 렌더 시점엔 window가 없다).
  const [isElectron, setIsElectron] = useState(false);
  useEffect(() => {
    setIsElectron(typeof window !== "undefined" && typeof window.audioCapture !== "undefined");
  }, []);

  // ── 차트 상세(자세히 보기) 뷰 — 어느 차트를 전체화면으로 열었는지 (null = 대시보드) ──
  const [detailChart, setDetailChart] = useState<DetailMetric | null>(null);

  // ── 모바일(lg 미만) 사이드바 슬라이드 오버레이 토글 ─────────────────────────
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // ── 데스크톱(lg 이상) 네이비 사이드바 접힘 토글 — Cmd/Ctrl+B ────────────────
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarCollapsed((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── sessionStorage 캐시용 최신값 미러 refs ────────────────────────────────
  // 이벤트 핸들러(pagehide 등)에서 stale closure 없이 최신 버퍼를 읽기 위함.
  const streamingFramesRef = useRef<AnalysisFrame[]>([]);
  const audioDurationRef   = useRef<number | null>(null);
  const fileNameRef        = useRef<string | null>(null);

  // ── WaveformPlayer ref (sendMessage/exportRecordedAudio 접근용) ──────────
  const realtimeWaveRef = useRef<WaveformPlayerHandle>(null);
  // ── MicrophonePlayer ref (exportRecordedAudio 접근용 — 파일 모드의 realtimeWaveRef와 동일 계약) ──
  const micWaveRef = useRef<MicrophonePlayerHandle>(null);
  // 채널 상세 뷰(ChartDetailOverlay)의 데이터 소스 — 입력 모드에 맞는 플레이어 핸들에서
  // 현재 캡처 버퍼를 WAV Blob으로 스냅샷 반환한다.
  const getChannelsBlob = useCallback(
    () => (inputMode === "file" ? realtimeWaveRef.current?.exportRecordedAudio() : micWaveRef.current?.exportRecordedAudio()) ?? null,
    [inputMode],
  );
  // ChartDetailOverlay 채널 뷰가 폴링 없이 실시간으로 구독하는 원본 캡처 청크 스트림 —
  // 입력 모드에 맞는 플레이어 핸들의 subscribeCaptureStream을 그대로 위임한다.
  const subscribeChannelStream = useCallback(
    (fn: CaptureStreamListener) => {
      const handle = inputMode === "file" ? realtimeWaveRef.current : micWaveRef.current;
      return handle?.subscribeCaptureStream(fn) ?? (() => {});
    },
    [inputMode],
  );
  // ── Step 3: Output Queue ────────────────────────────────────────────────
  const outputQueueRef       = useRef<QueuedFrame[]>([]);
  // Step 6: 직전 렌더 frame의 temperature (threshold crossing 감지용)
  const prevTempRef          = useRef<[number, number] | null>(null);
  // Calibration.tempWarn/tempDanger — Render Scheduler(setInterval)가 effect 재실행 없이
  // 최신값을 읽도록 ref로 미러링한다(변경 시 outputQueueRef를 리셋하지 않기 위해
  // 의도적으로 스케줄러 effect의 deps에는 넣지 않는다).
  const thresholdsRef        = useRef<TempThresholds>({ warn: DEFAULT_TEMP_WARN, danger: DEFAULT_TEMP_DANGER });

  // ── 캐시 미러 refs 동기화 (이벤트 핸들러에서 최신값 읽기용) ───────────────
  useEffect(() => { streamingFramesRef.current = streamingFrames; }, [streamingFrames]);
  useEffect(() => { audioDurationRef.current    = audioDuration;   }, [audioDuration]);

  // ── sessionStorage 프레임 캐시 + IndexedDB 오디오 복원 (F5/탭 전환 대응) ──────
  useFrameCachePersistence({
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
    const name = splitFileName(audioFile.name).stem || "Untitled";
    const recordedAudio = realtimeWaveRef.current?.exportRecordedAudio() ?? null;
    const { peakTemp, peakExcursion, status } = computeMeasurementSummary(frames, tempThresholds);
    await saveCurrent({
      name,
      audioFileName: recordedAudio ? `${name}.wav` : audioFile.name,
      audioDuration: audioDurationRef.current,
      analysisMode:  "realtime",
      frames,
      audioBlob: recordedAudio ?? audioFile,
      audioType: recordedAudio ? "audio/wav" : audioFile.type,
      peakTemp, peakExcursion, status,
    });
  }, [audioFile, saveCurrent, tempThresholds]);

  // ── 마이크(네이티브 캡처) 녹음 저장 — 전 채널 WAV + 실시간 분석 그래프를 워크스페이스에 보존 ──
  // 오디오는 엔진에 나간 ch0(V)/ch1(I)만이 아니라 Calibration에서 지정한 채널 수 전체가
  // 담긴 N채널 WAV(캡처 세션 버퍼)다. 분석 프레임은 realtime 버퍼를 그대로 싣는다.
  const handleSaveMicRecording = useCallback(async (rec: MicRecordingExport) => {
    const stamp = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const name =
      `capture-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}` +
      `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}-${rec.channels}ch`;
    const frames = streamingFramesRef.current;
    const { peakTemp, peakExcursion, status } = computeMeasurementSummary(frames, tempThresholds);
    await saveCurrent({
      name,
      audioFileName: `${name}.wav`,
      audioDuration: rec.durationSec,
      analysisMode:  "realtime",
      frames,
      audioBlob: rec.blob,
      audioType: "audio/wav",
      peakTemp, peakExcursion, status,
    });
  }, [saveCurrent, tempThresholds]);

  // ── 파일 선택 / 초기화 ────────────────────────────────────────────────────
  // 모든 분석 버퍼/상태를 새 음원 기준으로 비우는 공통 루틴 (캐시 I/O 제외)
  const resetAnalysisState = useCallback(() => {
    setAudioDuration(null);
    setStreamingFrames([]);
    setCurrentTime(0);
    setRealtimeStatus("idle");
    setErrorMsg(null);
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
    resetAnalysisState();
    clearFrameCache();
    void clearAudio();
  }, [resetAnalysisState]);

  const handleStreamStart = useCallback(() => {
    setStreamingFrames([]);
    outputQueueRef.current = [];
    prevTempRef.current    = null;
  }, []);

  // ── 렌더 윈도우 ──────────────────────────────────────────────────────────
  // 실시간 스트리밍 상태(streamingFrames)는 0초부터 전체 이력을 유지한다 — 차트 왼쪽 끝(0초)을
  // 고정한 "0초~현재" 뷰를 위해 상한을 두지 않는다. 대량 포인트 드로우 비용은 차트 쪽 LTTB
  // 다운샘플(large 모드)로 흡수한다. 긴 세션에서는 프레임 배열/메모리가 세션 길이에 비례해 증가.
  // ── 실험 토글: URL 쿼리로 제어 (측정 A/B용, 재빌드 불필요) ───────────────
  //   ?lttb=0 → 차트 LTTB 끔. 미지정 시 기본값(lttb=on) = 프로덕션 동작.
  const expParams    = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const LTTB_ENABLED  = expParams?.get("lttb") !== "0";
  // 출력 큐 스케줄러는 실시간 스트리밍 경로(파일 재생+캡처 / 마이크)에서만 동작
  const isPlaying = realtimeStatus === "playing";

  // ── 프레임 수신 — useQueue 모드에 따라 큐 push 또는 FIFO append ────────
  const handleFrameReceived = useCallback((frame: AnalysisFrame) => {
    if (useQueue) {
      outputQueueRef.current.push({ frame, recvAt: performance.now() });
    } else {
      // FIFO baseline: 수신 즉시 state append (0초 원점 고정 — 상한 없이 전체 이력 유지)
      setStreamingFrames((prev) => [...prev, frame]);
    }
  }, [useQueue]);

  // ── Step 3: Render Scheduler — 16ms마다 큐를 drain하여 state update ─────
  useEffect(() => {
    if (!isPlaying) return;
    if (!useQueue) return; // FIFO 모드: 스케줄러 불필요

    // 재생 시작 시 큐/직전 온도 초기화
    outputQueueRef.current = [];
    prevTempRef.current    = null;

    // 매 틱 + 스케줄러 종료(정지/일시정지) 시 마지막 한 번 모두 같은 드레인 로직을 탄다 —
    // cleanup에서도 호출해야 마지막 미처리 버킷이 유실되지 않는다(아래 참고).
    const drain = () => {
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

      // 0초 원점 고정 — 상한 없이 전체 이력 유지(왼쪽 끝이 스크롤되지 않게)
      setStreamingFrames((prev) => [...prev, ...renderFrames]);
    };

    const timer = setInterval(drain, RENDER_INTERVAL);

    // 정지/일시정지로 isPlaying이 false가 되면 이 effect가 정리되며 setInterval이 멈춘다 —
    // 그 순간 outputQueueRef에 아직 남아 있던(마지막 틱 이후 도착한) 프레임은 그대로
    // 유실된다. 채널 뷰(청크 즉시 push, 버퍼링 없음)는 이 영향을 받지 않아 항상 최신
    // 캡처 시점을 반영하는데, Temperature/Excursion만 그 마지막 버킷만큼 시간축이
    // 뒤처지는 원인이었다 — clearInterval 전에 남은 버킷을 한 번 더 드레인해 없앤다.
    return () => {
      clearInterval(timer);
      drain();
    };
  }, [isPlaying, useQueue]);

  // ── 상태 변경 ─────────────────────────────────────────────────────────────
  const handleRealtimeStatus = useCallback((s: AppStatus) => {
    setRealtimeStatus(s);
    if (s === "error") setErrorMsg("WebSocket 연결에 실패했습니다. 서버가 실행 중인지 확인해주세요.");
  }, []);

  // ── 재생 시각 갱신 ────────────────────────────────────────────────────────
  const handleRealtimeTime = useCallback((t: number) => {
    setCurrentTime(t);
  }, []);

  // 재생 중이거나, 표시할 캐시 프레임이 있으면 active (새로고침 후 캐시 복원 시에도 표시)
  const isActive = realtimeStatus === "playing" || realtimeStatus === "paused"
    || streamingFrames.length > 0;

  return (
    <div
      id="dashboard-root"
      className="flex flex-col lg:flex-row min-h-screen lg:h-screen lg:overflow-hidden"
    >
      <Sidebar
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
        collapsed={sidebarCollapsed}
      />

      <div id="content-column" className="relative flex-1 min-w-0 flex flex-col lg:h-screen lg:overflow-hidden">
        {/* 모바일(lg 미만) 전용 상단 바 — 햄버거로 사이드바를 슬라이드 오버레이로 연다 */}
        <div
          className="lg:hidden flex items-center gap-3 px-4 border-b border-iron-100 bg-white shrink-0"
          style={{ paddingTop: "env(safe-area-inset-top)", height: "calc(3.5rem + env(safe-area-inset-top))" }}
        >
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            aria-label="메뉴 열기"
            className="flex items-center justify-center w-9 h-9 rounded-lg text-iron-600 hover:bg-iron-100"
          >
            <Menu className="w-5 h-5" />
          </button>
          <span className="text-iron-900 text-[15px] font-extrabold tracking-tight">IRON DEVICE</span>
        </div>

        <main id="dashboard-main" className="flex-1 min-h-0 overflow-y-auto p-3 lg:p-7 pb-28 lg:pb-32">
          <div id="dashboard-content" className="lg:h-full w-full flex flex-col gap-4">
            {/* 상단: 타이틀/서브타이틀 + 입력 소스(파일/마이크) 세그먼트 토글 */}
            <div className="flex items-center gap-4 flex-wrap">
              <button
                type="button"
                onClick={() => setSidebarCollapsed((prev) => !prev)}
                aria-label={sidebarCollapsed ? "사이드바 펼치기 (⌘/Ctrl + B)" : "사이드바 숨기기 (⌘/Ctrl + B)"}
                title={sidebarCollapsed ? "사이드바 펼치기 (⌘/Ctrl + B)" : "사이드바 숨기기 (⌘/Ctrl + B)"}
                className="hidden lg:flex items-center justify-center w-8 h-8 rounded-lg text-iron-500 hover:bg-iron-100 hover:text-iron-700 transition-colors shrink-0"
              >
                {sidebarCollapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
              </button>
              <div className="mr-auto min-w-0">
                <h2 className="m-0 text-xl font-bold text-iron-900">
                  {inputMode === "file" ? "실시간 추적" : "마이크 입력"}
                </h2>
                <p className="m-0 mt-1 text-[13px] text-iron-500 truncate">
                  {inputMode === "file"
                    ? audioFile
                      ? `${audioFile.name} · ${formatTime(audioDuration ?? 0)}`
                      : "작업 영역에서 오디오 파일을 선택하세요"
                    : realtimeStatus === "playing"
                      ? "마이크 캡처 중"
                      : "마이크 대기"}
                </p>
              </div>
              <SegmentedControl
                value={inputMode}
                onChange={handleInputModeChange}
                options={[
                  { value: "file", label: "파일" },
                  { value: "mic", label: "마이크" },
                ]}
                className="w-[208px]"
                aria-label="입력 소스"
              />
            </div>

            {inputMode === "file" && !audioFile && <SelectedFilePanel />}

            {errorMsg && (
              <p id="error-message" className="error-message text-xs text-red-500 px-1 shrink-0">오류: {errorMsg}</p>
            )}

            <div id="dashboard-grid" className="flex flex-col gap-4 lg:flex-1 lg:min-h-[528px]">
              <div id="charts-section" className="flex flex-col gap-4 min-h-0 lg:flex-1">
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
              </div>
            </div>
          </div>
        </main>

        {/* 우측 드로어 3개 — content-column 기준 absolute, ActiveDrawerContext로 배타 전환 */}
        <WorkspaceDrawer />
        <RecordsDrawer />
        <CalibrationDrawer />

        {/* 플로팅 플레이어 독 — 파일 모드는 재생/파형/저장, 마이크 모드는 녹음/저장.
            Electron 파일 모드는 재생+캡처를 단일 IOProc으로 합친 DuplexFilePlayer(진행바만),
            웹 파일 모드는 WaveSurfer 재생 + 별도 캡처의 WaveformPlayer — 핸들 계약은 동일. */}
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
          getChannelsBlob={getChannelsBlob}
          subscribeChannelStream={subscribeChannelStream}
          onClose={() => setDetailChart(null)}
        />
      )}
    </div>
  );
}
