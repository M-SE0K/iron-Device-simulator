"use client";

// 내부 측정 하네스(scripts/measure.ts) 전용 토글 — 시작 시 raw/rendered 프레임·이벤트 로그를
// 초기화하고, 종료 시 요약 통계(RTT/렌더 지연/드롭율 등)를 계산해 JSON으로 내려받는다.
// 실시간 온도/익스커션 표시와는 분리된 기능이라 실패해도 측정 export만 영향을 받는다.
// refs/state는 DashboardClient(부모)가 계속 소유하고, 이 훅은 토글 로직만 제공한다
// (MicrophonePlayer capture 훅과 동일 패턴 — 다른 리셋 경로가 같은 상태를 직접 건드리므로
// 상태 소유권 자체를 옮기면 그 호출부들도 함께 고쳐야 해서 위험이 커진다).
import { useCallback, useEffect, type MutableRefObject } from "react";
import type { DebugLogEntry, MeasurementExport } from "@/features/audio/lib/debug/types";

type RawFrame = MeasurementExport["rawFrames"][number];
type EventLogEntry = MeasurementExport["summary"]["eventLog"][number];

export interface MeasurementCaptureDeps {
  isMeasuring: boolean;
  setIsMeasuring: (v: boolean) => void;
  setMeasureFrameCount: (v: number) => void;
  isMeasuringRef: MutableRefObject<boolean>;
  measureLogsRef: MutableRefObject<DebugLogEntry[]>;
  measureStartTimeRef: MutableRefObject<number>;
  rawFramesRef: MutableRefObject<RawFrame[]>;
  renderedFramesRef: MutableRefObject<RawFrame[]>;
  renderFreshnessLogsRef: MutableRefObject<number[]>;
  maxStreamingLenRef: MutableRefObject<number>;
  droppedFramesRef: MutableRefObject<number>;
  renderTickCountRef: MutableRefObject<number>;
  sourceCountSumRef: MutableRefObject<number>;
  preservedEventsRef: MutableRefObject<number>;
  eventLogRef: MutableRefObject<EventLogEntry[]>;
  audioFile: File | null;
  downloadJson: (obj: unknown, filename: string) => void;
}

export function useMeasurementCapture(deps: MeasurementCaptureDeps) {
  const {
    isMeasuring, setIsMeasuring, setMeasureFrameCount,
    isMeasuringRef, measureLogsRef, measureStartTimeRef, rawFramesRef, renderedFramesRef,
    renderFreshnessLogsRef, maxStreamingLenRef, droppedFramesRef, renderTickCountRef,
    sourceCountSumRef, preservedEventsRef, eventLogRef, audioFile, downloadJson,
  } = deps;

  // ── 측정 모드 토글 + JSON 다운로드 ──────────────────────────────────────
  const handleMeasureToggle = useCallback(() => {
    if (!isMeasuringRef.current) {
      // 측정 시작
      measureLogsRef.current           = [];
      rawFramesRef.current             = [];
      renderedFramesRef.current        = [];
      renderFreshnessLogsRef.current   = [];
      measureStartTimeRef.current      = performance.now();
      maxStreamingLenRef.current       = 0;
      isMeasuringRef.current      = true;
      setIsMeasuring(true);
      setMeasureFrameCount(0);
    } else {
      // 측정 종료 → JSON 다운로드
      isMeasuringRef.current = false;
      setIsMeasuring(false);

      const logs        = measureLogsRef.current;
      const durationSec = parseFloat(
        ((performance.now() - measureStartTimeRef.current) / 1000).toFixed(3)
      );

      // ── 요약 통계 계산 ─────────────────────────────────────────────────
      const avg = (arr: number[]) =>
        arr.length > 0 ? parseFloat((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)) : null;
      const safeMin = (arr: number[]) =>
        arr.length > 0 ? parseFloat(Math.min(...arr).toFixed(2)) : null;
      const safeMax = (arr: number[]) =>
        arr.length > 0 ? parseFloat(Math.max(...arr).toFixed(2)) : null;
      const percentile = (arr: number[], p: number) => {
        if (arr.length === 0) return null;
        const sorted = [...arr].sort((a, b) => a - b);
        const idx = Math.ceil(sorted.length * p / 100) - 1;
        return parseFloat(sorted[Math.max(0, idx)].toFixed(2));
      };
      const fullStats = (arr: number[]) => ({
        avg: avg(arr), min: safeMin(arr), max: safeMax(arr),
        p50: percentile(arr, 50), p95: percentile(arr, 95), p99: percentile(arr, 99),
      });

      const rttVals  = logs.map(l => l.rttMs).filter((v): v is number => v !== null);
      const srvVals  = logs.map(l => l.serverProcMs);
      const tempVals = logs.map(l => l.temperature);
      const excVals  = logs.map(l => l.excursion);
      const recvRenderVals = logs
        .map(l => l.totalRecvRenderMs)
        .filter((v): v is number => v !== null);
      const e2eVals  = logs
        .map(l => (l.rttMs !== null && l.totalRecvRenderMs !== null)
          ? parseFloat((l.rttMs + l.totalRecvRenderMs).toFixed(2))
          : null)
        .filter((v): v is number => v !== null);
      const freshnessVals = logs
        .map(l => l.freshnessLagMs)
        .filter((v): v is number => v !== null);
      const renderFreshnessVals = renderFreshnessLogsRef.current;

      const data: MeasurementExport = {
        meta: {
          recordedAt:             new Date().toISOString(),
          audioFile:              audioFile?.name ?? null,
          measurementDurationSec: durationSec,
          frameCount:             logs.length,
        },
        summary: {
          rtt:            fullStats(rttVals),
          serverProc:     { avg: avg(srvVals) },
          recvRender:     fullStats(recvRenderVals),
          e2e:            fullStats(e2eVals),
          freshnessLag:         fullStats(freshnessVals),
          renderFreshnessLag:   fullStats(renderFreshnessVals),
          temperature:    { avg: avg(tempVals) ?? 0, min: safeMin(tempVals) ?? 0, max: safeMax(tempVals) ?? 0 },
          excursion:      { avg: avg(excVals)  ?? 0, min: safeMin(excVals)  ?? 0, max: safeMax(excVals)  ?? 0 },
          maxStreamingFramesLen: maxStreamingLenRef.current,
          totalDroppedFrames:   droppedFramesRef.current,
          droppedFrameRatio:    logs.length > 0
            ? parseFloat((droppedFramesRef.current / (droppedFramesRef.current + logs.length)).toFixed(4))
            : null,
          avgSourceCount:       renderTickCountRef.current > 0
            ? parseFloat((sourceCountSumRef.current / renderTickCountRef.current).toFixed(2))
            : null,
          preservedEvents:      preservedEventsRef.current,
          eventLog:             eventLogRef.current,
        },
        frames:         logs,
        rawFrames:      rawFramesRef.current,
        renderedFrames: renderedFramesRef.current,
      };

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      downloadJson(data, `iron-device-measurement-${timestamp}.json`);
    }
  }, [audioFile, downloadJson]);

  // ── 측정 중 프레임 카운트 UI 갱신 (200ms 간격) ───────────────────────────
  useEffect(() => {
    if (!isMeasuring) return;
    const timer = setInterval(() => {
      setMeasureFrameCount(measureLogsRef.current.length);
    }, 200);
    return () => clearInterval(timer);
  }, [isMeasuring]);

  return { handleMeasureToggle };
}
