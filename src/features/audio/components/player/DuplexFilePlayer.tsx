"use client";

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import { useCalibration } from "@/features/audio/components/calibration/CalibrationContext";
import { useErrorPopup } from "@/shared/components/error-popup/ErrorPopupContext";
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
  /** 인터리브 스테레오 [L0,R0,L1,R1,...] — 모노 소스는 OfflineAudioContext가 L=R로 업믹스한다. */
  pcm: Float32Array;
  rate: number;
  duration: number;
}

// L/R 두 평면 채널을 [L0,R0,L1,R1,...] 인터리브 하나로 합친다 — 이 인터리브 포맷이 그대로
// play-capture 헬퍼의 --ref 파일 바이트가 된다(렌더러↔네이티브 헬퍼 간 청크 업로드 프로토콜은
// 무변경, 파일 내용의 의미만 모노→스테레오로 바뀐다).
function interleaveStereo(l: Float32Array, r: Float32Array): Float32Array {
  const out = new Float32Array(l.length * 2);
  for (let i = 0; i < l.length; i++) {
    out[i * 2] = l[i];
    out[i * 2 + 1] = r[i];
  }
  return out;
}

async function decodeFileToStereo(file: File, targetRate: number): Promise<DecodedPlayback> {
  const arrayBuf = await file.arrayBuffer();
  const probeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await probeCtx.decodeAudioData(arrayBuf);
  } finally {
    void probeCtx.close();
  }
  const frames = Math.ceil(decoded.duration * targetRate);
  const offline = new OfflineAudioContext(2, frames, targetRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const pcm = interleaveStereo(rendered.getChannelData(0), rendered.getChannelData(1));
  return { pcm, rate: targetRate, duration: decoded.duration };
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
        onTimeUpdate(pos);
      }
    });
    return off;
  }, [captureSession.subscribeCaptureStream, onTimeUpdate]);

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
    subscribeCaptureStream: captureSession.subscribeCaptureStream,
  }), [captureSession.sendMessage, pausePlayback, captureSession.getRecordedBlob, captureSession.getProtectedBlob, captureSession.subscribeCaptureStream]);

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
