"use client";

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { Play, Pause, Square } from "lucide-react";
import { cn, formatTime } from "@/shared/lib/utils";
import { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import { StreamDebugInfo, DebugLogEntry } from "@/features/audio/lib/debug/types";
import { useCalibration } from "@/features/audio/components/calibration/CalibrationContext";
import { useCaptureSession } from "./capture/useCaptureSession";

// ─── 카드 내부 비율 (%) — 자유롭게 조절 ──────────────────────────────────────
// header(타이틀 영역) + body(파형 + 컨트롤) = 100
const WAVEFORM_BODY_PERCENT   = 80;        // body가 차지할 카드 높이 비율
const WAVEFORM_HEADER_PERCENT = 100 - WAVEFORM_BODY_PERCENT;
// 'auto' = body 영역에 자동으로 맞춤. 숫자(px)로 고정 높이 지정도 가능.
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
        waveColor:     "#CDD1DA",
        progressColor: "#0057B8",
        cursorColor:   "#1A73E8",
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

  // ── 일시정지 (캡처 세션 연결은 유지하되, 저장 버퍼 축적은 멈춘다) ────────────
  // 세션(소켓/네이티브 캡처)까지 통째로 끊으면 재개 시 다시 열어야 하는데, 그러면 WASM의
  // 온도 누적 상태가 리셋되고 차트도 비워진다. 그래서 분석은 계속 흘러가게 두고(파일이
  // 멈추면 실제 앰프 출력도 줄어 V/I가 자연히 감쇠 → 실제 냉각을 그대로 반영), 저장 파일에만
  // 이 무음 구간이 안 섞이도록 recordingActiveRef만 끈다.
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
  const progress  = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div id="waveform-player" className="card h-full flex flex-col overflow-hidden">
      {/* 카드 헤더 — 비율: WAVEFORM_HEADER_PERCENT% */}
      <div
        className="card-header shrink-0"
        style={{ height: `${WAVEFORM_HEADER_PERCENT}%` }}
      >
        <span className="card-title">Waveform</span>
        <div className="flex items-center gap-3">
          {captureSession.sampleRate !== null && (
            <span id="waveform-engine-config" className="font-mono text-xs text-iron-400">
              {captureSession.sampleRate.toLocaleString()}Hz
              {captureSession.actualBufferSize !== null && ` · buf ${captureSession.actualBufferSize}`}
            </span>
          )}
          {isReady && (
            <span id="waveform-time-display" className="font-mono text-xs text-iron-400">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          )}
        </div>
      </div>

      {/* 카드 바디 — 비율: WAVEFORM_BODY_PERCENT% */}
      <div
        className="waveform-body p-4 flex flex-col gap-3 min-h-0 overflow-hidden"
        style={{ height: `${WAVEFORM_BODY_PERCENT}%` }}
      >
        {/* WaveSurfer 캔버스 — body 안에서 남는 공간을 모두 차지 */}
        <div
          id="waveform-canvas"
          ref={containerRef}
          className={cn(
            "w-full flex-1 min-h-0 rounded-lg bg-iron-50 overflow-hidden",
            !audioFile && "flex items-center justify-center"
          )}
        >
          {!audioFile && (
            <p className="waveform-placeholder text-xs text-iron-400">파일을 업로드하면 파형이 표시됩니다</p>
          )}
        </div>

        {/* 진행 바 */}
        {isReady && (
          <div id="playback-progress-track" className="h-1 bg-iron-100 rounded-full overflow-hidden shrink-0">
            <div
              id="playback-progress-fill"
              className="h-full bg-brand-blue transition-all duration-100"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {/* 재생 컨트롤 + 현재 재생 시간 */}
        <div id="player-controls" className="flex items-center gap-2 shrink-0">
          <button
            id="play-pause-btn"
            onClick={handlePlayPause}
            disabled={!isReady}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
              isReady
                ? "bg-brand-blue text-white hover:bg-brand-blue-dark"
                : "bg-iron-100 text-iron-300 cursor-not-allowed"
            )}
          >
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
            {isPlaying ? "Pause" : "Play"}
          </button>

          <button
            id="stop-btn"
            onClick={handleStop}
            disabled={!isReady}
            className={cn(
              "p-2 rounded-lg transition-all",
              isReady
                ? "text-iron-500 hover:bg-iron-100 hover:text-iron-700"
                : "text-iron-300 cursor-not-allowed"
            )}
          >
            <Square size={14} />
          </button>

          {/* 현재 재생 시간 — 큰 표시 */}
          <span
            id="playback-time"
            className={cn(
              "ml-3 font-mono text-base font-semibold tabular-nums",
              isReady ? "text-iron-800" : "text-iron-300"
            )}
          >
            {formatTime(currentTime)}
            <span className="text-iron-400 font-normal"> / {formatTime(duration)}</span>
          </span>

          {/* 스트리밍 연결 상태 표시 */}
          {isReady && (
            <span className="ml-auto text-xs text-iron-400 flex items-center gap-1.5">
              <span
                className={cn(
                  "inline-block w-1.5 h-1.5 rounded-full",
                  isPlaying ? "bg-green-400 animate-pulse" : "bg-iron-300"
                )}
              />
              {isPlaying ? "스트리밍 중" : "대기"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

export default WaveformPlayer;
