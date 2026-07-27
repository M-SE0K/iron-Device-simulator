import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AnalysisFrame } from "@/features/audio/types";
import { perf } from "@/features/audio/lib/perf/collector";
import { e2e } from "@/features/audio/lib/perf-e2e/collector";
import {
  computeStreamWindow,
  WINDOW_SIZE,
} from "@/features/audio/lib/render/chart-window";
import {
  extractZoomState,
  shouldShowFrameSymbols,
} from "@/features/audio/lib/render/chart-option";

type Metric = "temperature" | "excursion";

interface MetricChartRuntimeOptions {
  metric: Metric;
  frames: AnalysisFrame[];
  currentTime: number;
  isActive: boolean;
  streaming: boolean;
  audioDuration?: number | null;
  perfTrack: boolean;
}

export function useMetricChartRuntime({
  metric,
  frames,
  currentTime,
  isActive,
  streaming,
  audioDuration,
  perfTrack,
}: MetricChartRuntimeOptions) {
  const zoomRef = useRef({ start: 0, end: 100 });
  const [showSymbols, setShowSymbols] = useState(false);
  const pointCountRef = useRef(0);
  useEffect(() => {
    zoomRef.current = { start: 0, end: 100 };
    setShowSymbols(false);
  }, [audioDuration]);

  const prevFrameLenRef = useRef(0);
  const renderStartAtRef = useRef(0);
  const pendingCommitSampleRef = useRef(false);
  if (perfTrack && streaming && frames.length !== prevFrameLenRef.current) {
    prevFrameLenRef.current = frames.length;
    // N12 시작점은 렌더 단계(커밋 전)에서 찍어야 한다 — useLayoutEffect에서 찍으면 자식
    // ReactECharts의 componentDidUpdate(자식이 부모보다 먼저 커밋됨)가 이미 setOption을
    // 호출한 뒤라 늦어서, 이번 렌더가 아니라 다음 drain 사이클의 rendered 이벤트를 붙잡는다.
    renderStartAtRef.current = performance.now();
    pendingCommitSampleRef.current = true;
  }
  useLayoutEffect(() => {
    if (pendingCommitSampleRef.current) {
      pendingCommitSampleRef.current = false;
      e2e.sampleSinceCommit("N11", metric);
    }
  });

  const rendered = useCallback(() => {
    if (perfTrack && renderStartAtRef.current > 0) {
      const renderMs = performance.now() - renderStartAtRef.current;
      perf.recordRender(metric, renderMs);
      e2e.sample("N12", renderMs, metric);
      renderStartAtRef.current = 0;
    }
  }, [metric, perfTrack]);

  const datazoom = useCallback((params: unknown) => {
    const zoom = extractZoomState(params);
    if (zoom) zoomRef.current = zoom;
    const next = shouldShowFrameSymbols(pointCountRef.current, zoomRef.current);
    setShowSymbols((prev) => (prev === next ? prev : next));
  }, []);

  const echartsEvents = useRef<Record<string, (...args: unknown[]) => void>>({});
  echartsEvents.current = { rendered, datazoom };

  const { current, windowFrames } = useMemo(
    () => computeStreamWindow(
      frames,
      currentTime,
      isActive,
      streaming,
      audioDuration,
      WINDOW_SIZE,
      metric === "temperature" ? (frame) => frame.temperature : (frame) => frame.excursion,
    ),
    [frames, currentTime, isActive, streaming, audioDuration, metric],
  );
  pointCountRef.current = windowFrames.length;

  return {
    current,
    windowFrames,
    zoomRef,
    showSymbols,
    echartsEvents: echartsEvents.current,
    showChart: audioDuration != null || frames.length > 0,
  };
}
