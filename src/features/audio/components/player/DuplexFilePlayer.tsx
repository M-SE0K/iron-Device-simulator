"use client";

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import { useCalibration } from "@/features/audio/components/calibration/CalibrationContext";
import { useErrorPopup } from "@/shared/components/error-popup/ErrorPopupContext";
import { SAMPLE_RATE } from "@/features/audio/lib/engine/core";
import { decodeFileToStereo, type DecodedPlayback } from "@/features/audio/lib/codec/playback-decode";
import { useCaptureSession } from "./capture/useCaptureSession";
import type { WaveformPlayerHandle } from "./capture/types";
import PlayerBar from "./PlayerBar";

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
}

const DuplexFilePlayer = forwardRef<WaveformPlayerHandle, Props>(function DuplexFilePlayer({
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
}: Props, ref) {
  const { values: calibration } = useCalibration();
  const { showError } = useErrorPopup();

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]       = useState(0);
  const [isReady, setIsReady]         = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
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
    setIsConnecting(false);
    setCurrentTime(0);
    setDuration(0);

    if (!audioFile) return;
    let cancelled = false;

    (async () => {
      try {
        const reqRate = Number(calibration.sampleRate) || SAMPLE_RATE;
        const decoded = await decodeFileToStereo(audioFile, reqRate);
        if (cancelled) return;
        decodedRef.current = decoded;
        setDuration(decoded.duration);
        setIsReady(true);
        onStatusChange("ready");
        onDurationReady?.(decoded.duration);
      } catch {
        if (cancelled) return;
        showError("Unable to decode audio file.");
        onStatusChange("error");
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioFile]);

  useEffect(() => {
    if (status === "error") captureStartedRef.current = false;
    if (status === "playing" || status === "error") setIsConnecting(false);
  }, [status]);

  useEffect(() => {
    if (captureSession.micError) {
      captureStartedRef.current = false;
      setIsConnecting(false);
    }
  }, [captureSession.micError]);

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
      }
    });
    return off;
  }, [captureSession.subscribeCaptureStream]);

  const handlePlaybackEnded = useCallback(() => {
    captureSession.cleanup();
    captureStartedRef.current = false;
    setIsConnecting(false);
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
    setIsConnecting(true);
    if (decoded.rate !== reqRate && audioFile) {
      try {
        decoded = await decodeFileToStereo(audioFile, reqRate);
        decodedRef.current = decoded;
        setDuration(decoded.duration);
      } catch {
        setIsConnecting(false);
        showError("Unable to decode audio file.");
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
    captureSession.resumeRecording, captureSession.start, handlePlaybackEnded, onStatusChange, showError,
  ]);

  const handleStop = useCallback(() => {
    captureSession.cleanup();
    captureStartedRef.current = false;
    capturedFramesRef.current = 0;
    setIsConnecting(false);
    setCurrentTime(0);
    onStatusChange("ready");
  }, [captureSession.cleanup, onStatusChange]);

  useImperativeHandle(ref, () => ({
    sendMessage: captureSession.sendMessage,
    pause: pausePlayback,
    exportRecordedAudio: captureSession.getRecordedBlob,
    exportProtectedAudio: captureSession.getProtectedBlob,
    getCaptureSnapshot: captureSession.getCaptureSnapshot,
    subscribeCaptureStream: captureSession.subscribeCaptureStream,
  }), [
    captureSession.sendMessage, pausePlayback, captureSession.getRecordedBlob,
    captureSession.getProtectedBlob, captureSession.getCaptureSnapshot, captureSession.subscribeCaptureStream,
  ]);

  const isPlaying = status === "playing";
  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <PlayerBar
      isReady={isReady}
      isPlaying={isPlaying}
      isConnecting={isConnecting}
      currentTime={currentTime}
      duration={duration}
      fileName={audioFile?.name ?? null}
      onPlayPause={handlePlayPause}
      onStop={handleStop}
      onSave={onSave}
      canSave={canSave}
      onReset={audioFile ? onReset : undefined}
    >
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
            Upload a file to start playback
          </p>
        )}
      </div>
    </PlayerBar>
  );
});

export default DuplexFilePlayer;
