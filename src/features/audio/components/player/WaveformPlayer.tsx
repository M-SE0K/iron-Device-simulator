"use client";

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { Play, Pause, Square, Save, X } from "lucide-react";
import { cn, formatTime } from "@/shared/lib/utils";
import { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import { StreamDebugInfo, DebugLogEntry } from "@/features/audio/lib/debug/types";
import { useCalibration } from "@/features/audio/components/calibration/CalibrationContext";
import { useCaptureSession } from "./capture/useCaptureSession";

// 'auto' = 파형 컨테이너 높이(CSS)에 자동으로 맞춤.
const WAVEFORM_CANVAS_HEIGHT: number | "auto" = "auto";

interface Props {
  audioFile: File | null;
  status: AppStatus;
  onTimeUpdate: (currentTime: number) => void;
  onStatusChange: (status: AppStatus) => void;
  /** 캡처 세션(V/I)에서 분석된 프레임 콜백 */
  onFrameReceived: (frame: AnalysisFrame) => void;
  /** 새 캡처 세션 시작 시 — 누적 프레임 초기화 신호 */
  onStreamStart: () => void;
  /** 디버그 메트릭 업데이트 (10fps 스로틀) */
  onDebugUpdate?: (info: Partial<StreamDebugInfo>) => void;
  /** 프레임 단위 로그 엔트리 (매 프레임 호출, 버퍼링은 호출자 책임) */
  onDebugLog?: (entry: DebugLogEntry) => void;
  /** AMP 출력 전력 / 스피커 모델 파라미터 */
  inputParams?: InputParameterValues;
  /** 오디오 총 길이 확정 시 콜백 (초 단위) */
  onDurationReady?: (duration: number) => void;
  /** 작업 영역에 현재 음원+분석 그래프 저장 (플로팅 독의 저장 아이콘) — SelectedFilePanel에서 이전 */
  onSave?: () => void;
  canSave?: boolean;
  /** 선택된 파일 초기화 (플로팅 독의 X 아이콘) — SelectedFilePanel에서 이전 */
  onReset?: () => void;
}

/** page.tsx에서 ref로 접근할 수 있는 WaveformPlayer 핸들 */
export interface WaveformPlayerHandle {
  /** 분석 소켓이 열려 있을 때 JSON 메시지를 전송 */
  sendMessage: (msg: object) => void;
  /**
   * 재생을 일시정지한다 (캡처 세션은 유지 → 재개 시 스트림/차트 보존).
   * 모드 전환 시 떠나는 플레이어의 오디오만 멈추는 용도.
   */
  pause: () => void;
  /**
   * 캡처 세션 버퍼(ch0=V/ch1=I + Calibration에서 확장한 채널)를 WAV로 인코딩해 반환한다.
   * 원본 업로드 파일이 아니라, 재생 중 MCHStreamer 등에서 실제로 캡처된 신호를 담는다.
   * 캡처 세션이 없었거나(재생한 적 없음) 데이터가 없으면 null.
   */
  exportRecordedAudio: () => Blob | null;
}

const WaveformPlayer = forwardRef<WaveformPlayerHandle, Props>(function WaveformPlayer({
  audioFile,
  status,
  onTimeUpdate,
  onStatusChange,
  onFrameReceived,
  onStreamStart,
  onDebugUpdate,
  onDebugLog,
  inputParams,
  onDurationReady,
  onSave,
  canSave = false,
  onReset,
}: Props, ref) {
  const { values: calibration } = useCalibration();

  const containerRef  = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<import("wavesurfer.js").default | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]       = useState(0);
  const [isReady, setIsReady]         = useState(false);
  // 캡처 세션이 이미 열려 있는지 — 열려 있으면 재생 재개 시 세션을 다시 여는 대신
  // 저장 버퍼만 재개한다(resumeRecording). 세션을 통째로 재시작하면 WASM 온도 누적
  // 상태가 리셋되고 차트도 비워지기 때문.
  const captureStartedRef = useRef(false);

  // ── 캡처 세션 — 재생과 동시에 시작/종료된다. 파일 자체를 분석하지 않고, 재생을 통해
  // 실제 하드웨어(MCHStreamer 등)에서 캡처되는 ch0(V)/ch1(I)를 분석한다(마이크 모드와 동일 파이프라인).
  const captureSession = useCaptureSession({
    status, onStatusChange, onFrameReceived, onStreamStart,
    onDebugUpdate, onDebugLog, inputParams,
  });

  // ── 파일 변경 시: WaveSurfer 재초기화 + 이전 캡처 세션 정리 ────────────────
  useEffect(() => {
    // 이전 세션 정리(파일이 바뀌면 이전 파일에 연결된 캡처는 의미 없음)
    captureSession.cleanup();
    captureStartedRef.current = false;
    setIsReady(false);
    setCurrentTime(0);
    setDuration(0);

    if (!containerRef.current || !audioFile) return;

    let ws: import("wavesurfer.js").default;
    let destroyed = false;

    (async () => {
      const WaveSurfer = (await import("wavesurfer.js")).default;
      if (destroyed) return;

      if (wavesurferRef.current) {
        wavesurferRef.current.destroy();
        wavesurferRef.current = null;
      }

      ws = WaveSurfer.create({
        container:     containerRef.current!,
        waveColor:     "#CBD5E1",
        progressColor: "#0B4171",
        cursorColor:   "#0B4171",
        cursorWidth:   2,
        barWidth:      2,
        barGap:        1,
        barRadius:     2,
        height:        WAVEFORM_CANVAS_HEIGHT,
        normalize:     true,
        interact:      true,
      });

      ws.on("ready", (dur) => {
        if (destroyed) return;
        setDuration(dur);
        setIsReady(true);
        onStatusChange("ready");
        onDurationReady?.(dur);
      });

      ws.on("timeupdate", (time) => {
        if (destroyed) return;
        setCurrentTime(time);
        onTimeUpdate(time);
      });

      ws.on("finish", () => {
        if (destroyed) return;
        captureSession.cleanup();
        captureStartedRef.current = false;
        onStatusChange("paused");
      });

      const url = URL.createObjectURL(audioFile);
      ws.load(url);
      wavesurferRef.current = ws;
    })();

    return () => {
      destroyed = true;
      ws?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioFile]);

  // ── 재생 출력 라우팅 (setSinkId) ─────────────────────────────────────────
  // 캘리브레이션의 outputDeviceId로 재생을 특정 출력(예: 앰프/스피커가 물린 MCHStreamer 출력)에
  // 보낸다. WaveSurfer(미디어 엘리먼트)가 준비된 뒤 + 값이 바뀔 때마다 적용. 표준 웹 setSinkId라
  // 웹·Electron 공통이며, "" 이면 시스템 기본 출력. 미지원/권한 미충족 시엔 조용히 무시한다.
  useEffect(() => {
    const wv = wavesurferRef.current as (import("wavesurfer.js").default & {
      setSinkId?: (id: string) => Promise<void>;
    }) | null;
    if (!isReady || !wv || typeof wv.setSinkId !== "function") return;
    wv.setSinkId(calibration.outputDeviceId || "").catch(() => {
      /* setSinkId 미지원(비보안 컨텍스트 등)·잘못된 deviceId — 기본 출력 유지 */
    });
  }, [isReady, calibration.outputDeviceId]);

  // ── 일시정지 (캡처 세션 연결은 유지하되, 분석 프레임 전송 + 저장 버퍼 축적을 함께 멈춘다) ──
  // 세션(소켓/네이티브 캡처)까지 통째로 끊으면 재개 시 다시 열어야 하는데, 그러면 WASM의
  // 온도 누적 상태가 리셋되고 차트도 비워진다. 그래서 세션은 열어 둔 채(pauseRecording)
  // 데이터 흐름만 멈춘다 — 이러면 소켓 frameCount(= 차트 시간축)와 온도가 정지 지점에 고정되어,
  // 재개 시 시간축이 튀지 않고 그 지점부터 이어진다(정지 지점 10s → 재개 시 10s부터).
  const pausePlayback = useCallback(() => {
    const wv = wavesurferRef.current;
    if (!wv || !wv.isPlaying()) return;
    wv.pause();
    captureSession.pauseRecording();
    onStatusChange("paused");
  }, [onStatusChange, captureSession.pauseRecording]);

  // ── 재생/일시정지 ─────────────────────────────────────────────────────────
  const handlePlayPause = useCallback(() => {
    if (!wavesurferRef.current || !isReady) return;

    if (wavesurferRef.current.isPlaying()) {
      pausePlayback();
    } else {
      wavesurferRef.current.play();
      onStatusChange("playing");
      if (captureStartedRef.current) {
        // 일시정지에서 재개 — 이미 열린 세션의 저장 버퍼만 다시 켠다.
        captureSession.resumeRecording();
      } else {
        // 최초 재생 — 파일 출력과 동시에 캡처 세션을 시작해 실제 하드웨어 응답(V/I)을 분석한다.
        captureStartedRef.current = true;
        void captureSession.start();
      }
    }
  }, [isReady, pausePlayback, onStatusChange, captureSession.start, captureSession.resumeRecording]);

  // ── 정지 ─────────────────────────────────────────────────────────────────
  const handleStop = useCallback(() => {
    if (!wavesurferRef.current) return;
    wavesurferRef.current.stop();
    setCurrentTime(0);
    captureSession.cleanup();
    captureStartedRef.current = false;
    onStatusChange("ready");
  }, [captureSession.cleanup, onStatusChange]);

  // page.tsx에서 ref.current.sendMessage()로 WS 전송
  useImperativeHandle(ref, () => ({
    sendMessage: captureSession.sendMessage,
    pause: pausePlayback,
    exportRecordedAudio: captureSession.getRecordedBlob,
  }), [captureSession.sendMessage, pausePlayback, captureSession.getRecordedBlob]);

  const isPlaying = status === "playing";

  // 플로팅 필 독 — #content-column 기준 하단 중앙 고정 (WaveformPlayer.tsx의 리스킨 계획 참고).
  return (
    <div
      id="waveform-player"
      className="absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 bg-white rounded-full shadow-[0_12px_40px_rgba(15,23,42,0.16)] py-2 pl-2 pr-4 sm:pr-7 w-[calc(100%-1.5rem)] sm:w-[720px] max-w-[720px]"
      style={{ bottom: "calc(28px + env(safe-area-inset-bottom))" }}
    >
      <button
        id="play-pause-btn"
        onClick={handlePlayPause}
        disabled={!isReady}
        aria-label={isPlaying ? "일시정지" : "재생"}
        className={cn(
          "flex items-center justify-center w-12 h-12 rounded-full shrink-0 transition-colors",
          isReady
            ? "bg-brand-blue text-white hover:bg-brand-blue-dark"
            : "bg-iron-100 text-iron-300 cursor-not-allowed"
        )}
      >
        {isPlaying ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
      </button>

      {/* WaveSurfer 캔버스 */}
      <div
        id="waveform-canvas"
        ref={containerRef}
        className={cn(
          "flex-1 min-w-0 h-9 overflow-hidden",
          !audioFile && "flex items-center justify-center"
        )}
      >
        {!audioFile && (
          <p className="waveform-placeholder text-xs text-iron-300 truncate">파일을 업로드하면 파형이 표시됩니다</p>
        )}
      </div>

      {/* 현재 재생 시간 */}
      <span
        id="playback-time"
        className={cn(
          "hidden sm:inline shrink-0 font-semibold text-sm tabular-nums",
          isReady ? "text-iron-900" : "text-iron-300"
        )}
      >
        {formatTime(currentTime)}
        <span className="text-iron-400 font-normal"> / {formatTime(duration)}</span>
      </span>

      <div className="hidden sm:block w-px h-5 bg-iron-200 shrink-0" />

      {/* 파일명 */}
      <span className="hidden md:inline shrink-0 max-w-[150px] truncate text-[13px] text-iron-500">
        {audioFile?.name ?? "—"}
      </span>

      {/* 스트리밍 연결 상태 */}
      <span className="hidden sm:flex shrink-0 items-center gap-1.5 text-xs text-iron-500">
        <span
          className={cn(
            "inline-block w-[7px] h-[7px] rounded-full",
            isPlaying ? "bg-emerald-500 animate-pulse" : "bg-iron-300"
          )}
        />
        {isPlaying ? "스트리밍 중" : "일시정지됨"}
      </span>

      <button
        id="stop-btn"
        onClick={handleStop}
        disabled={!isReady}
        title="정지"
        aria-label="정지"
        className={cn(
          "shrink-0 p-1.5 rounded-full transition-colors",
          isReady ? "text-iron-400 hover:bg-iron-100 hover:text-iron-700" : "text-iron-200 cursor-not-allowed"
        )}
      >
        <Square size={14} />
      </button>

      {onSave && (
        <button
          onClick={onSave}
          disabled={!canSave}
          title="작업 영역에 저장"
          aria-label="작업 영역에 저장"
          className={cn(
            "shrink-0 p-1.5 rounded-full transition-colors",
            canSave ? "text-iron-400 hover:bg-iron-100 hover:text-brand-blue" : "text-iron-200 cursor-not-allowed"
          )}
        >
          <Save size={14} />
        </button>
      )}

      {onReset && audioFile && (
        <button
          onClick={onReset}
          title="파일 초기화"
          aria-label="파일 초기화"
          className="shrink-0 p-1.5 rounded-full text-iron-400 hover:bg-iron-100 hover:text-iron-700 transition-colors"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
});

export default WaveformPlayer;
