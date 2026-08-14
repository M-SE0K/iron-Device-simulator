"use client";

import { useCallback, useEffect, type MutableRefObject } from "react";
import type { AppStatus } from "@/features/audio/types";
import { saveFrameCache, loadFrameCache } from "@/features/audio/lib/cache/frame";
import { getCachedAudio } from "@/features/audio/lib/cache/audio-blob";
import type { ChartStore } from "@/features/audio/lib/render/chart-store";

export interface FrameCachePersistenceDeps {
  audioFile: File | null;
  realtimeStatus: AppStatus;
  /**
   * 차트 표시 데이터의 단일 소유자. 저장/복원 모두 이 스토어를 거치므로 sessionStorage에
   * 나가는 프레임 수도 스토어의 표시 점 상한(MAX_CHART_POINTS)에 묶인다 — 예전엔 누적
   * 프레임 전체를 직렬화해 긴 세션에서 쿼터를 넘길 수 있었다.
   */
  chartStore: ChartStore;
  audioDurationRef: MutableRefObject<number | null>;
  fileNameRef: MutableRefObject<string | null>;
  /** 캐시에서 프레임을 복원했을 때 — 대시보드가 "그릴 게 있음" 상태로 전환하도록. */
  onFramesRestored: () => void;
  setAudioDuration: (duration: number | null) => void;
  setAudioFile: (file: File | null) => void;
}

/**
 * 저장/복원을 **스스로** 처리한다 — 복원은 마운트 시 1회, 저장은 정지 상태 전환·pagehide·
 * 탭 숨김에 반응하는 이펙트가 맡는다. 호출부가 직접 부를 것이 없어 아무것도 돌려주지 않는다.
 */
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
