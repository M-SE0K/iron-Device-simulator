"use client";

// sessionStorage 프레임 캐시(chart data) + IndexedDB 오디오 blob 복원 — 탭 전환 후 재마운트나
// F5 새로고침 시 파형/차트를 그대로 되살린다. 실패해도 실시간 온도/익스커션 표시 자체와는
// 무관하고 F5 복원만 영향을 받는다. 두 refs(streamingFramesRef 등)는 handleSaveToWorkspace와
// 파일 선택/리셋/모드전환 라이프사이클(c-4, 미착수)도 함께 읽고 쓰므로 DashboardClient(부모)가
// 계속 소유하고 이 훅에 주입한다(MicrophonePlayer capture 훅과 동일 패턴).
import { useCallback, useEffect, type MutableRefObject } from "react";
import type { AppStatus, AnalysisFrame } from "@/features/audio/types";
import { saveFrameCache, loadFrameCache } from "@/features/audio/lib/cache/frame";
import { getCachedAudio } from "@/features/audio/lib/cache/audio-blob";

export interface FrameCachePersistenceDeps {
  audioFile: File | null;
  realtimeStatus: AppStatus;
  batchStatus: AppStatus;
  streamingFramesRef: MutableRefObject<AnalysisFrame[]>;
  batchFramesRef: MutableRefObject<AnalysisFrame[]>;
  audioDurationRef: MutableRefObject<number | null>;
  analysisModeRef: MutableRefObject<"realtime" | "batch">;
  fileNameRef: MutableRefObject<string | null>;
  setStreamingFrames: (frames: AnalysisFrame[]) => void;
  setBatchFrames: (frames: AnalysisFrame[]) => void;
  setAudioDuration: (duration: number | null) => void;
  setAnalysisMode: (mode: "realtime" | "batch") => void;
  setAudioFile: (file: File | null) => void;
}

export function useFrameCachePersistence(deps: FrameCachePersistenceDeps) {
  const {
    audioFile, realtimeStatus, batchStatus,
    streamingFramesRef, batchFramesRef, audioDurationRef, analysisModeRef, fileNameRef,
    setStreamingFrames, setBatchFrames, setAudioDuration, setAnalysisMode, setAudioFile,
  } = deps;

  // ── sessionStorage 저장 헬퍼 ──────────────────────────────────────────────
  const persistCache = useCallback(() => {
    saveFrameCache({
      fileName:       audioFile?.name ?? fileNameRef.current,
      audioDuration:  audioDurationRef.current,
      analysisMode:   analysisModeRef.current,
      realtimeFrames: streamingFramesRef.current,
      batchFrames:    batchFramesRef.current,
    });
  }, [audioFile]);

  // ── 마운트 시 캐시 복원 (탭 전환 후 재마운트 / 새로고침 대응) ──────────────
  useEffect(() => {
    const snap = loadFrameCache();
    if (snap) {
      if (snap.realtimeFrames.length) { setStreamingFrames(snap.realtimeFrames); streamingFramesRef.current = snap.realtimeFrames; }
      if (snap.batchFrames.length)    { setBatchFrames(snap.batchFrames);        batchFramesRef.current     = snap.batchFrames; }
      if (snap.audioDuration != null) { setAudioDuration(snap.audioDuration);     audioDurationRef.current    = snap.audioDuration; }
      setAnalysisMode(snap.analysisMode);
      analysisModeRef.current = snap.analysisMode;
      fileNameRef.current = snap.fileName;
    }

    // 오디오 원본(IndexedDB) 복원 → WaveformPlayer가 재디코딩하여 파형을 다시 그린다.
    // handleFileSelected를 거치지 않으므로 복원된 차트 캐시를 비우지 않는다.
    let cancelled = false;
    void getCachedAudio().then((file) => {
      if (cancelled || !file) return;
      fileNameRef.current = file.name;
      setAudioFile(file);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 재생 정지(paused/ready) 시 캐시 저장 ──────────────────────────────────
  useEffect(() => {
    const stalled = (s: AppStatus) => s === "paused" || s === "ready";
    if (stalled(realtimeStatus) || stalled(batchStatus)) persistCache();
  }, [realtimeStatus, batchStatus, persistCache]);

  // ── 탭 숨김/이탈(새로고침 포함) 직전 캐시 저장 ────────────────────────────
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
