"use client";

// WaveformPlayer→DashboardClient 렌더 파이프라인의 지연(RTT/react/echarts/freshness lag)을
// 집계하고, METRICS_INTERVAL마다 분석 소켓 호환 핸들로 metrics 메시지 전송(현재 소비자 없음). 실패해도
// 디버그 패널/콘솔 로그만 영향을 받고 실시간
// 온도/익스커션 표시 자체는 영향 없다. refs는 DashboardClient(부모)가 계속 소유하고,
// 이 훅은 그 refs를 읽고 쓰는 핸들러 함수만 제공한다(MicrophonePlayer capture 훅과 동일 패턴).
import { useCallback, type MutableRefObject, type RefObject } from "react";
import type { StreamDebugInfo, DebugLogEntry } from "@/features/audio/lib/debug/types";
import type { WaveformPlayerHandle } from "@/features/audio/components/player/WaveformPlayer";

interface RenderMetrics {
  reactMs: number | null;
  echartsMs: number | null;
  totalRecvMs: number | null;
  totalE2eMs: number | null;
}

export interface RenderTelemetryDeps {
  /** 분석 소켓 호환 핸들로 metrics 메시지 전송(현재 소비자 없음) */
  realtimeWaveRef: RefObject<WaveformPlayerHandle | null>;
  frameRecvAtRef: MutableRefObject<number>;
  reactRenderAtRef: MutableRefObject<number>;
  latestRttRef: MutableRefObject<number | null>;
  latestRenderMetrics: MutableRefObject<RenderMetrics>;
  metricsCountRef: MutableRefObject<number>;
  METRICS_INTERVAL: number;
  latestFrameIdxRef: MutableRefObject<number>;
  latestAudioTimeRef: MutableRefObject<number>;
  latestRttMsRef: MutableRefObject<number | null>;
  latestSrvProcMsRef: MutableRefObject<number | null>;
  currentTimeRef: MutableRefObject<number>;
  latestFrameTimeRef: MutableRefObject<number>;
  isMeasuringRef: MutableRefObject<boolean>;
  renderFreshnessLogsRef: MutableRefObject<number[]>;
  measureLogsRef: MutableRefObject<DebugLogEntry[]>;
}

export function useRenderTelemetry(deps: RenderTelemetryDeps) {
  const {
    realtimeWaveRef, frameRecvAtRef, reactRenderAtRef, latestRttRef, latestRenderMetrics,
    metricsCountRef, METRICS_INTERVAL, latestFrameIdxRef, latestAudioTimeRef,
    latestRttMsRef, latestSrvProcMsRef, currentTimeRef, latestFrameTimeRef,
    isMeasuringRef, renderFreshnessLogsRef, measureLogsRef,
  } = deps;

  // ── 디버그 업데이트 시 최신 rtt/srv 캐시 ────────────────────────────────
  const handleDebugUpdate = useCallback((info: Partial<StreamDebugInfo>) => {
    if (info.latestRttMs !== undefined)       { latestRttRef.current = info.latestRttMs; latestRttMsRef.current = info.latestRttMs; }
    if (info.serverProcessingMs !== undefined) latestSrvProcMsRef.current = info.serverProcessingMs;
  }, []);

  // ── React 렌더 완료 콜백 (TemperatureChart useLayoutEffect에서 호출) ──────
  const handleReactRender = useCallback((ts: number) => {
    reactRenderAtRef.current = ts;
  }, []);

  // ── ECharts 렌더 완료 콜백 (TemperatureChart onEvents rendered에서 호출) ──
  const handleEchartsRender = useCallback((ts: number) => {
    const echartsMs      = parseFloat((ts - reactRenderAtRef.current).toFixed(2));
    const totalRecvMs    = parseFloat((ts - frameRecvAtRef.current).toFixed(2));
    const rtt            = latestRttRef.current;
    const totalE2eMs     = rtt !== null
      ? parseFloat((rtt + totalRecvMs).toFixed(2))
      : null;

    // freshness lag 계산: 현재 오디오 재생 시각 - 최신 렌더된 frame의 time
    const audioNow       = currentTimeRef.current;
    const renderedTime   = latestFrameTimeRef.current;
    const freshnessLagMs = audioNow > 0 && renderedTime > 0
      ? parseFloat(((audioNow - renderedTime) * 1000).toFixed(2))
      : null;

    const reactMs = parseFloat((reactRenderAtRef.current - frameRecvAtRef.current).toFixed(2));
    latestRenderMetrics.current = { reactMs, echartsMs, totalRecvMs, totalE2eMs };

    if (isMeasuringRef.current && freshnessLagMs !== null) {
      renderFreshnessLogsRef.current.push(freshnessLagMs);
    }

    // ── 분석 소켓 호환 핸들로 metrics 메시지 전송(현재 소비자 없음) ───────────
    metricsCountRef.current++;
    if (metricsCountRef.current % METRICS_INTERVAL === 0) {
      realtimeWaveRef.current?.sendMessage({
        type:              "metrics",
        frameIdx:          latestFrameIdxRef.current,
        audioTime:         latestAudioTimeRef.current,
        rttMs:             latestRttMsRef.current,
        serverProcMs:      latestSrvProcMsRef.current,
        reactRenderMs:     reactMs,
        echartsRenderMs:   echartsMs,
        totalRecvRenderMs: totalRecvMs,
        totalE2eMs,
      });
    }

    // 브라우저 콘솔 요약
    if (metricsCountRef.current % METRICS_INTERVAL === 0) {
      console.debug(
        `[Pipeline] RTT:${rtt?.toFixed(2) ?? "—"}ms` +
        ` | react:${reactMs}ms | echarts:${echartsMs}ms` +
        ` | recv→render:${totalRecvMs}ms | E2E:${totalE2eMs ?? "—"}ms`
      );
    }
  }, [METRICS_INTERVAL]);

  // ── 프레임 로그 엔트리 수집 ───────────────────────────────────────────────
  const handleDebugLog = useCallback((entry: DebugLogEntry) => {
    // 최신 frameIdx/audioTime 캐시
    latestFrameIdxRef.current  = entry.frameIdx;
    latestAudioTimeRef.current = entry.audioTime;
    // 직전 렌더 사이클의 render 타임을 첨부
    const m = latestRenderMetrics.current;
    // freshness lag 계산
    const audioNow     = currentTimeRef.current;
    const frameTime    = entry.audioTime;
    const freshLag     = audioNow > 0 && frameTime > 0
      ? parseFloat(((audioNow - frameTime) * 1000).toFixed(2))
      : null;
    const enriched: DebugLogEntry = {
      ...entry,
      reactRenderMs:     m.reactMs,
      echartsRenderMs:   m.echartsMs,
      totalRecvRenderMs: m.totalRecvMs,
      freshnessLagMs:    freshLag,
    };
    // 측정 모드: 제한 없이 별도 버퍼에 누적
    if (isMeasuringRef.current) {
      measureLogsRef.current.push(enriched);
    }
  }, []);

  return { handleDebugUpdate, handleReactRender, handleEchartsRender, handleDebugLog };
}
