import { useCallback, useEffect, useRef } from "react";
import { timeDecimalsForInterval } from "@/features/audio/lib/render/uplot-option";
import type { ChartMetric, ChartStore } from "@/features/audio/lib/render/chart-store";
import { useThrottledStoreSnapshot } from "./useThrottledStoreSnapshot";

/**
 * 스트리밍 차트가 React 상태로 들고 있어야 하는 값만 갱신하는 주기(ms).
 *
 * 그래프 자체는 ChartStore → UPlotChart의 source 경로로 React를 거치지 않고 커밋되므로,
 * 여기서 리렌더가 필요한 건 헤더의 현재값 숫자와 축 소수점 자리수뿐이다. 프레임 도착
 * 빈도(초당 100회 이상)와 무관하게 이 주기로만 리렌더한다.
 */
const READOUT_INTERVAL_MS = 100;

interface MetricChartRuntimeOptions {
  metric: ChartMetric;
  store: ChartStore;
  isActive: boolean;
  audioDuration?: number | null;
}

interface Readout {
  current: number | null;
  hasPoints: boolean;
  timeDecimals: number;
}

const isSameReadout = (previous: Readout, next: Readout) => (
  previous.current === next.current
  && previous.hasPoints === next.hasPoints
  && previous.timeDecimals === next.timeDecimals
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
      timeDecimals: timeDecimalsForInterval(snapshot.pointInterval),
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
    timeDecimals: readout.timeDecimals,
    showChart: audioDuration != null || readout.hasPoints,
  };
}
