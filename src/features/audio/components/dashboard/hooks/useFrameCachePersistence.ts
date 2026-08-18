"use client";

import { useCallback, useEffect, type MutableRefObject } from "react";
import type { AppStatus } from "@/features/audio/types";
import { saveFrameCache, loadFrameCache } from "@/features/audio/lib/cache/frame";
import { getCachedAudio } from "@/features/audio/lib/cache/audio-blob";
import type { ChartStore } from "@/features/audio/lib/render/chart-store";

export interface FrameCachePersistenceDeps {
  audioFile: File | null;
  realtimeStatus: AppStatus;
  chartStore: ChartStore;
  audioDurationRef: MutableRefObject<number | null>;
  fileNameRef: MutableRefObject<string | null>;
  onFramesRestored: () => void;
  setAudioDuration: (duration: number | null) => void;
  setAudioFile: (file: File | null) => void;
}

export function useFrameCachePersistence(deps: FrameCachePersistenceDeps): void {
  const {
    audioFile, realtimeStatus,
    chartStore, audioDurationRef, fileNameRef,
    onFramesRestored, setAudioDuration, setAudioFile,
  } = deps;

  const persistCache = useCallback(() => {
    saveFrameCache({
      fileName:       audioFile?.name ?? fileNameRef.current,
      audioDuration:  audioDurationRef.current,
      realtimeFrames: chartStore.toFrames(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioFile, chartStore]);

  useEffect(() => {
    const snap = loadFrameCache();
    if (snap) {
      if (snap.realtimeFrames.length) { chartStore.seed(snap.realtimeFrames); onFramesRestored(); }
      if (snap.audioDuration != null) { setAudioDuration(snap.audioDuration); audioDurationRef.current = snap.audioDuration; }
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
}
