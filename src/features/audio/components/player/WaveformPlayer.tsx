"use client";

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { Play, Pause, Square } from "lucide-react";
import { cn, formatTime } from "@/shared/lib/utils";
import { AppStatus, AnalysisFrame, StreamDebugInfo, DebugLogEntry, InputParameterValues } from "@/features/audio/types";
import { useCalibration } from "@/features/audio/components/calibration/CalibrationContext";
import { usePcmDecoder } from "./stream/usePcmDecoder";
import { useAnalysisStream } from "./stream/useAnalysisStream";
import { useBatchAnalysis } from "./stream/useBatchAnalysis";

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
  /** WebSocket으로 수신된 분석 프레임 콜백 */
  onFrameReceived: (frame: AnalysisFrame) => void;
  /** 새 스트리밍 세션 시작 시 — 누적 프레임 초기화 신호 */
  onStreamStart: () => void;
  /** 디버그 메트릭 업데이트 (10fps 스로틀) */
  onDebugUpdate?: (info: Partial<StreamDebugInfo>) => void;
  /** 프레임 단위 로그 엔트리 (매 프레임 호출, 버퍼링은 호출자 책임) */
  onDebugLog?: (entry: DebugLogEntry) => void;
  /** AMP 출력 전력 / 스피커 모델 파라미터 */
  inputParams?: InputParameterValues;
  /** 오디오 총 길이 확정 시 콜백 (초 단위) */
  onDurationReady?: (duration: number) => void;
  /** false면 재생 시 실시간 스트리밍(WS/rAF) 없이 오디오 재생만 (배치 모드) */
  enableStreaming?: boolean;
}

/** page.tsx에서 ref로 접근할 수 있는 WaveformPlayer 핸들 */
export interface WaveformPlayerHandle {
  /** 분석 소켓이 열려 있을 때 JSON 메시지를 전송 */
  sendMessage: (msg: object) => void;
  /**
   * 배치 분석: 디코딩된 전체 PCM frame을 한 번에 분석해
   * 전체 output frame 시퀀스를 반환한다 (재생 동기화 없음).
   * @param onProgress (done, total) 진행률 콜백
   */
  runBatchAnalysis: (onProgress?: (done: number, total: number) => void) => Promise<AnalysisFrame[]>;
  /** 진행 중인 실시간 스트리밍 분석 소켓을 닫는다 (모드 전환 시 이전 세션 정리). */
  stopStreaming: () => void;
  /**
   * 재생을 일시정지한다 (WebSocket은 닫지 않음 → 재개 시 스트림/차트 보존).
   * 모드 전환 시 떠나는 플레이어의 오디오만 멈추는 용도.
   */
  pause: () => void;
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
  enableStreaming = true,
}: Props, ref) {
  const { values: calibration } = useCalibration();

  const containerRef  = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<import("wavesurfer.js").default | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]       = useState(0);
  const [isReady, setIsReady]         = useState(false);

  // inputParams ref: prop 변경 시 최신값을 클로저에서 참조할 수 있게 유지
  const inputParamsRef = useRef<InputParameterValues | undefined>(inputParams);
  useEffect(() => { inputParamsRef.current = inputParams; }, [inputParams]);

  // ── PCM 디코딩 파이프라인 (AudioContext 디코딩 → 프레임 청킹) ─────────────
  const { pcmFramesRef, pcmReadyRef, engineConfigRef, displayConfig } = usePcmDecoder(
    audioFile, calibration.sampleRate, calibration.bufferSize,
  );

  // ── 실시간 분석 스트림 (소켓 open/close, rAF 전송 루프, RTT/디버그) ────────
  const stream = useAnalysisStream({
    wavesurferRef, pcmFramesRef, engineConfigRef, inputParamsRef,
    onStreamStart, onFrameReceived, onStatusChange, onDebugUpdate, onDebugLog,
  });

  // ── 배치 분석 (재생 동기화 없이 전체 PCM을 한 번에 분석) ───────────────────
  const { runBatchAnalysis } = useBatchAnalysis({
    pcmFramesRef, pcmReadyRef, engineConfigRef, inputParamsRef,
  });

  // ── 파일/엔진설정 변경 시: WaveSurfer 재초기화 (PCM 디코딩은 usePcmDecoder가 별도로 담당) ──
  useEffect(() => {
    // 이전 세션 정리
    stream.reset();
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
        stream.close();
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
  }, [audioFile, calibration.sampleRate, calibration.bufferSize]);

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

  // ── 일시정지 (WebSocket 유지 → 재개 시 스트림/차트 보존) ──────────────────
  const pausePlayback = useCallback(() => {
    const wv = wavesurferRef.current;
    if (!wv || !wv.isPlaying()) return;
    wv.pause();
    stream.pauseStream();
    onStatusChange("paused");
  }, [stream.pauseStream, onStatusChange]);

  // ── 재생/일시정지 ─────────────────────────────────────────────────────────
  const handlePlayPause = useCallback(() => {
    if (!wavesurferRef.current || !isReady) return;

    if (wavesurferRef.current.isPlaying()) {
      pausePlayback();
    } else {
      // 재생
      wavesurferRef.current.play();
      onStatusChange("playing");
      // 배치 모드: 실시간 스트리밍 없이 오디오 재생만 (차트는 이미 분석 완료 상태)
      if (enableStreaming) stream.open();
    }
  }, [isReady, pausePlayback, stream.open, onStatusChange, enableStreaming]);

  // ── 정지 ─────────────────────────────────────────────────────────────────
  const handleStop = useCallback(() => {
    if (!wavesurferRef.current) return;
    wavesurferRef.current.stop();
    setCurrentTime(0);
    stream.close();
    onStatusChange("ready");
  }, [stream.close, onStatusChange]);

  // page.tsx에서 ref.current.sendMessage()로 WS 전송
  useImperativeHandle(ref, () => ({
    sendMessage: stream.sendMessage,
    runBatchAnalysis,
    stopStreaming: stream.close,
    pause: pausePlayback,
  }), [stream.sendMessage, stream.close, runBatchAnalysis, pausePlayback]);

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
          {displayConfig && (
            <span id="waveform-engine-config" className="font-mono text-xs text-iron-400">
              {displayConfig.sampleRate.toLocaleString()}Hz · buf {displayConfig.samplesPerCh}
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
