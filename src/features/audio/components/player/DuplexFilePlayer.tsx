"use client";

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { Play, Pause, Square, Save, X } from "lucide-react";
import { cn, formatTime } from "@/shared/lib/utils";
import { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import { useCalibration } from "@/features/audio/components/calibration/CalibrationContext";
import { SAMPLE_RATE } from "@/features/audio/lib/engine/core";
import { useCaptureSession } from "./capture/useCaptureSession";
import type { WaveformPlayerHandle } from "./WaveformPlayer";

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

interface DecodedPlayback {
  pcm: Float32Array;
  rate: number;
  duration: number;
}

async function decodeFileToMono(file: File, targetRate: number): Promise<DecodedPlayback> {
  const arrayBuf = await file.arrayBuffer();
  const probeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await probeCtx.decodeAudioData(arrayBuf);
  } finally {
    void probeCtx.close();
  }
  const frames = Math.ceil(decoded.duration * targetRate);
  const offline = new OfflineAudioContext(1, frames, targetRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return { pcm: rendered.getChannelData(0).slice(), rate: targetRate, duration: decoded.duration };
}

const DuplexFilePlayer = forwardRef<WaveformPlayerHandle, Props>(function DuplexFilePlayer({
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

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]       = useState(0);
  const [isReady, setIsReady]         = useState(false);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const decodedRef = useRef<DecodedPlayback | null>(null);
  const captureStartedRef = useRef(false);
  const capturedFramesRef = useRef(0);
  const lastUiUpdateRef = useRef(0);

  const captureSession = useCaptureSession({
    status, onStatusChange, onFrameReceived, onStreamStart,
    inputParams,
  });

  useEffect(() => {
    captureSession.cleanup();
    captureStartedRef.current = false;
    capturedFramesRef.current = 0;
    decodedRef.current = null;
    setIsReady(false);
    setDecodeError(null);
    setCurrentTime(0);
    setDuration(0);

    if (!audioFile) return;
    let cancelled = false;

    (async () => {
      try {
        const reqRate = Number(calibration.sampleRate) || SAMPLE_RATE;
        const decoded = await decodeFileToMono(audioFile, reqRate);
        if (cancelled) return;
        decodedRef.current = decoded;
        setDuration(decoded.duration);
        setIsReady(true);
        onStatusChange("ready");
        onDurationReady?.(decoded.duration);
      } catch {
        if (cancelled) return;
        setDecodeError("오디오 파일을 디코드할 수 없습니다.");
        onStatusChange("error");
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioFile]);

  useEffect(() => {
    if (status === "error") captureStartedRef.current = false;
  }, [status]);

  useEffect(() => {
    const off = captureSession.subscribeCaptureStream((ev) => {
      if (ev.type === "reset") {
        capturedFramesRef.current = 0;
        return;
      }
      if (ev.type !== "chunk") return;
      capturedFramesRef.current += ev.chunk.byteLength / (ev.channels * 2);
      const pos = Math.min(capturedFramesRef.current / ev.sampleRate, decodedRef.current?.duration ?? Infinity);
      const now = performance.now();
      if (now - lastUiUpdateRef.current >= 100) {
        lastUiUpdateRef.current = now;
        setCurrentTime(pos);
        onTimeUpdate(pos);
      }
    });
    return off;
  }, [captureSession.subscribeCaptureStream, onTimeUpdate]);

  const handlePlaybackEnded = useCallback(() => {
    captureSession.cleanup();
    captureStartedRef.current = false;
    setCurrentTime(decodedRef.current?.duration ?? 0);
    onStatusChange("paused");
  }, [captureSession.cleanup, onStatusChange]);

  const pausePlayback = useCallback(() => {
    if (!captureStartedRef.current || status !== "playing") return;
    captureSession.pauseRecording();
    onStatusChange("paused");
  }, [status, captureSession.pauseRecording, onStatusChange]);

  const handlePlayPause = useCallback(async () => {
    if (!isReady) return;

    if (status === "playing") {
      pausePlayback();
      return;
    }
    if (captureStartedRef.current) {
      captureSession.resumeRecording();
      onStatusChange("playing");
      return;
    }
    let decoded = decodedRef.current;
    if (!decoded) return;
    const reqRate = Number(calibration.sampleRate) || SAMPLE_RATE;
    if (decoded.rate !== reqRate && audioFile) {
      try {
        decoded = await decodeFileToMono(audioFile, reqRate);
        decodedRef.current = decoded;
        setDuration(decoded.duration);
      } catch {
        setDecodeError("오디오 파일을 디코드할 수 없습니다.");
        onStatusChange("error");
        return;
      }
    }
    captureStartedRef.current = true;
    setCurrentTime(0);
    void captureSession.start({
      playbackPcm: decoded.pcm,
      onPlaybackEnded: handlePlaybackEnded,
    });
  }, [
    isReady, status, audioFile, calibration.sampleRate, pausePlayback,
    captureSession.resumeRecording, captureSession.start, handlePlaybackEnded, onStatusChange,
  ]);

  const handleStop = useCallback(() => {
    captureSession.cleanup();
    captureStartedRef.current = false;
    capturedFramesRef.current = 0;
    setCurrentTime(0);
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
  const errorText = decodeError ?? captureSession.micError;
  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

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

      <div id="duplex-progress" className="flex-1 min-w-0 h-9 flex items-center">
        {audioFile ? (
          <div className="w-full h-1.5 rounded-full bg-iron-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-brand-blue transition-[width] duration-100 ease-linear"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        ) : (
          <p className="waveform-placeholder text-xs text-iron-300 truncate mx-auto">
            파일을 업로드하면 재생할 수 있습니다
          </p>
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

      <span
        className={cn(
          "hidden sm:flex shrink-0 items-center gap-1.5 text-xs",
          errorText ? "text-red-500 max-w-[160px]" : "text-iron-500"
        )}
        title={errorText ?? undefined}
      >
        <span
          className={cn(
            "inline-block w-[7px] h-[7px] rounded-full",
            errorText ? "bg-red-500" : isPlaying ? "bg-emerald-500 animate-pulse" : "bg-iron-300"
          )}
        />
        <span className="truncate">{errorText ?? (isPlaying ? "스트리밍 중" : "일시정지됨")}</span>
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

export default DuplexFilePlayer;
