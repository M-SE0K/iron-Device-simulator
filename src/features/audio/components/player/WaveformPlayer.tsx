"use client";

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { Play, Pause, Square, Save, X } from "lucide-react";
import { cn, formatTime } from "@/shared/lib/utils";
import { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import { useCalibration } from "@/features/audio/components/calibration/CalibrationContext";
import { useCaptureSession, type CaptureStreamListener } from "./capture/useCaptureSession";

const WAVEFORM_CANVAS_HEIGHT: number | "auto" = "auto";

interface Props {
  audioFile: File | null;
  status: AppStatus;
  onTimeUpdate: (currentTime: number) => void;
  onStatusChange: (status: AppStatus) => void;
  onFrameReceived: (frame: AnalysisFrame) => void;
  onStreamStart: () => void;
  inputParams?: InputParameterValues;
  onDurationReady?: (duration: number) => void;
  onSave?: () => void;
  canSave?: boolean;
  onReset?: () => void;
  elevated?: boolean;
}

export interface WaveformPlayerHandle {
  sendMessage: (msg: object) => void;
  pause: () => void;
  exportRecordedAudio: () => Blob | null;
  exportProtectedAudio: () => Blob | null;
  subscribeCaptureStream: (fn: CaptureStreamListener) => () => void;
}

const WaveformPlayer = forwardRef<WaveformPlayerHandle, Props>(function WaveformPlayer({
  audioFile,
  status,
  onTimeUpdate,
  onStatusChange,
  onFrameReceived,
  onStreamStart,
  inputParams,
  onDurationReady,
  onSave,
  canSave = false,
  onReset,
  elevated = false,
}: Props, ref) {
  const { values: calibration } = useCalibration();

  const containerRef  = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<import("wavesurfer.js").default | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]       = useState(0);
  const [isReady, setIsReady]         = useState(false);
  const captureStartedRef = useRef(false);

  const captureSession = useCaptureSession({
    status, onStatusChange, onFrameReceived, onStreamStart,
    inputParams,
  });

  useEffect(() => {
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

  useEffect(() => {
    if (status === "error") captureStartedRef.current = false;
  }, [status]);

  useEffect(() => {
    const wv = wavesurferRef.current as (import("wavesurfer.js").default & {
      setSinkId?: (id: string) => Promise<void>;
    }) | null;
    if (!isReady || !wv || typeof wv.setSinkId !== "function") return;
    wv.setSinkId(calibration.outputDeviceId || "").catch(() => {
    });
  }, [isReady, calibration.outputDeviceId]);

  const pausePlayback = useCallback(() => {
    const wv = wavesurferRef.current;
    if (!wv || !wv.isPlaying()) return;
    wv.pause();
    captureSession.pauseRecording();
    onStatusChange("paused");
  }, [onStatusChange, captureSession.pauseRecording]);

  const handlePlayPause = useCallback(() => {
    if (!wavesurferRef.current || !isReady) return;

    if (wavesurferRef.current.isPlaying()) {
      pausePlayback();
    } else {
      wavesurferRef.current.play();
      onStatusChange("playing");
      if (captureStartedRef.current) {
        captureSession.resumeRecording();
      } else {
        captureStartedRef.current = true;
        void captureSession.start();
      }
    }
  }, [isReady, pausePlayback, onStatusChange, captureSession.start, captureSession.resumeRecording]);

  const handleStop = useCallback(() => {
    if (!wavesurferRef.current) return;
    wavesurferRef.current.stop();
    setCurrentTime(0);
    captureSession.cleanup();
    captureStartedRef.current = false;
    onStatusChange("ready");
  }, [captureSession.cleanup, onStatusChange]);

  useImperativeHandle(ref, () => ({
    sendMessage: captureSession.sendMessage,
    pause: pausePlayback,
    exportRecordedAudio: captureSession.getRecordedBlob,
    exportProtectedAudio: captureSession.getProtectedBlob,
    subscribeCaptureStream: captureSession.subscribeCaptureStream,
  }), [captureSession.sendMessage, pausePlayback, captureSession.getRecordedBlob, captureSession.getProtectedBlob, captureSession.subscribeCaptureStream]);

  const isPlaying = status === "playing";

  return (
    <div
      id="waveform-player"
      className={cn(
        "absolute left-1/2 -translate-x-1/2 flex items-center gap-3 bg-white rounded-full shadow-[0_12px_40px_rgba(15,23,42,0.16)] py-2 pl-2 pr-4 sm:pr-7 w-[calc(100%-1.5rem)] sm:w-[640px] max-w-[640px]",
        elevated ? "z-[65]" : "z-30",
      )}
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

      <span className="hidden md:inline shrink-0 max-w-[150px] truncate text-[13px] text-iron-500">
        {audioFile?.name ?? "—"}
      </span>

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
