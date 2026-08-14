import { useCallback, useEffect, useRef } from "react";
import type { ChartMetric, ChartStore } from "@/features/audio/lib/render/chart-store";
import { READOUT_INTERVAL_MS, useThrottledStoreSnapshot } from "./useThrottledStoreSnapshot";

interface MetricChartRuntimeOptions {
  metric: ChartMetric;
  store: ChartStore;
  isActive: boolean;
  audioDuration?: number | null;
}

interface Readout {
  current: number | null;
  hasPoints: boolean;
}

const isSameReadout = (previous: Readout, next: Readout) => (
  previous.current === next.current
  && previous.hasPoints === next.hasPoints
);

export function useMetricChartRuntime({
  metric,
  store,
  isActive,
  audioDuration,
}: MetricChartRuntimeOptions) {
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  const selectReadout = useCallback((snapshot: ReturnType<ChartStore["snapshot"]>): Readout => {
    const raw = metric === "temperature" ? snapshot.lastTemperature : snapshot.lastExcursion;
    return {
      current: isActiveRef.current && snapshot.count > 0 ? raw : null,
      hasPoints: snapshot.count > 0,
    };
  }, [metric]);

  const [readout, setReadout] = useThrottledStoreSnapshot(
    store,
    selectReadout,
    isSameReadout,
    READOUT_INTERVAL_MS,
  );

  // 정지되면 현재값 표시는 다음 스토어 갱신을 기다리지 않고 즉시 비운다.
  useEffect(() => {
    if (isActive) return;
    setReadout((previous) => (
      previous.current === null ? previous : { ...previous, current: null }
    ));
  }, [isActive, setReadout]);

  return {
    current: readout.current,
    showChart: audioDuration != null || readout.hasPoints,
  };
}
