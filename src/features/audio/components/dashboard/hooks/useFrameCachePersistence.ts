"use client";

import { useCallback, useEffect, type MutableRefObject } from "react";
import type { AppStatus, AnalysisFrame } from "@/features/audio/types";
import { saveFrameCache, loadFrameCache } from "@/features/audio/lib/cache/frame";
import { getCachedAudio } from "@/features/audio/lib/cache/audio-blob";

export interface FrameCachePersistenceDeps {
  audioFile: File | null;
  realtimeStatus: AppStatus;
  streamingFramesRef: MutableRefObject<AnalysisFrame[]>;
  audioDurationRef: MutableRefObject<number | null>;
  fileNameRef: MutableRefObject<string | null>;
  setStreamingFrames: (frames: AnalysisFrame[]) => void;
  setAudioDuration: (duration: number | null) => void;
  setAudioFile: (file: File | null) => void;
}

export function useFrameCachePersistence(deps: FrameCachePersistenceDeps) {
  const {
    audioFile, realtimeStatus,
    streamingFramesRef, audioDurationRef, fileNameRef,
    setStreamingFrames, setAudioDuration, setAudioFile,
  } = deps;

  const persistCache = useCallback(() => {
    saveFrameCache({
      fileName:       audioFile?.name ?? fileNameRef.current,
      audioDuration:  audioDurationRef.current,
      realtimeFrames: streamingFramesRef.current,
    });
  }, [audioFile]);

  useEffect(() => {
    const snap = loadFrameCache();
    if (snap) {
      if (snap.realtimeFrames.length) { setStreamingFrames(snap.realtimeFrames); streamingFramesRef.current = snap.realtimeFrames; }
      if (snap.audioDuration != null) { setAudioDuration(snap.audioDuration);     audioDurationRef.current    = snap.audioDuration; }
      fileNameRef.current = snap.fileName;
    }

    let cancelled = false;
    void getCachedAudio().then((file) => {
      if (cancelled || !file) return;
      fileNameRef.current = file.name;
      setAudioFile(file);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const stalled = (s: AppStatus) => s === "paused" || s === "ready";
    if (stalled(realtimeStatus)) persistCache();
  }, [realtimeStatus, persistCache]);

  useEffect(() => {
    const onPageHide = () => persistCache();
    const onVisibility = () => { if (document.visibilityState === "hidden") persistCache(); };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [persistCache]);

  return { persistCache };
}
