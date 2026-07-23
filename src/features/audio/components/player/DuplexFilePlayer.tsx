"use client";

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import { useCalibration } from "@/features/audio/components/calibration/CalibrationContext";
import { SAMPLE_RATE } from "@/features/audio/lib/engine/core";
import { useCaptureSession } from "./capture/useCaptureSession";
import type { WaveformPlayerHandle } from "./WaveformPlayer";
import PlayerBar from "./PlayerBar";

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
        setDecodeError("Unable to decode audio file.");
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
        setDecodeError("Unable to decode audio file.");
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
    <PlayerBar
      isReady={isReady}
      isPlaying={isPlaying}
      currentTime={currentTime}
      duration={duration}
      fileName={audioFile?.name ?? null}
      onPlayPause={handlePlayPause}
      onStop={handleStop}
      errorText={errorText}
      onSave={onSave}
      canSave={canSave}
      onReset={audioFile ? onReset : undefined}
      elevated={elevated}
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
