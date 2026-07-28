import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { AnalysisFrame } from "@/features/audio/types";
import { perf } from "@/features/audio/lib/perf/collector";
import { e2e } from "@/features/audio/lib/perf-e2e/collector";
import {
  computeStreamWindow,
  WINDOW_SIZE,
} from "@/features/audio/lib/render/chart-window";

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
  const prevFrameLenRef = useRef(0);
  const pendingRenderSampleRef = useRef(false);
  const pendingCommitSampleRef = useRef(false);
  if (perfTrack && streaming && frames.length !== prevFrameLenRef.current) {
    prevFrameLenRef.current = frames.length;
    pendingRenderSampleRef.current = true;
    pendingCommitSampleRef.current = true;
  }
  useLayoutEffect(() => {
    if (pendingCommitSampleRef.current) {
      pendingCommitSampleRef.current = false;
      e2e.sampleSinceCommit("N11", metric);
    }
  });

  // uPlot은 setData 안에서 동기적으로 캔버스를 다시 그린다 — UPlotChart가 그 구간을
  // 직접 측정해 ms로 보고하므로 그대로 기록한다. 스트리밍 프레임 커밋이 아닌 드로우
  // (줌 조작, 인스턴스 재생성 등)는 샘플에서 제외한다.
  const onRender = useCallback((ms: number) => {
    if (!pendingRenderSampleRef.current) return;
    pendingRenderSampleRef.current = false;
    perf.recordRender(metric, ms);
    e2e.sample("N12", ms, metric);
  }, [metric]);

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

  return {
    current,
    windowFrames,
    onRender,
    showChart: audioDuration != null || frames.length > 0,
  };
}
