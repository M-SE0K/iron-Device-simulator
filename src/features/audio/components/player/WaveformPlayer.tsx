"use client";

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { cn } from "@/shared/lib/utils";
import { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import { useCalibration } from "@/features/audio/components/calibration/CalibrationContext";
import { useCaptureSession } from "./capture/useCaptureSession";
import type { CaptureStreamListener } from "./capture/types";
import PlayerBar from "./PlayerBar";

const WAVEFORM_CANVAS_HEIGHT: number | "auto" = "auto";

interface Props {
  audioFile: File | null;
  status: AppStatus;
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
    <PlayerBar
      isReady={isReady}
      isPlaying={isPlaying}
      currentTime={currentTime}
      duration={duration}
      fileName={audioFile?.name ?? null}
      onPlayPause={handlePlayPause}
      onStop={handleStop}
      onSave={onSave}
      canSave={canSave}
      onReset={audioFile ? onReset : undefined}
      elevated={elevated}
    >
      <div
        id="waveform-canvas"
        ref={containerRef}
        className={cn(
          "flex-1 min-w-0 h-9 overflow-hidden",
          !audioFile && "flex items-center justify-center"
        )}
      >
        {!audioFile && (
          <p className="waveform-placeholder text-xs text-iron-300 truncate">Upload a file to see the waveform</p>
        )}
      </div>
    </PlayerBar>
  );
});

export default WaveformPlayer;
