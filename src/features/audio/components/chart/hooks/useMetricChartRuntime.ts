import { useCallback, useEffect, useRef } from "react";
import type { ChartMetric, ChartStore } from "@/features/audio/lib/render/chart-store";
import {
  DEFAULT_STORE_READOUT_INTERVAL_MS,
  useThrottledStoreSnapshot,
} from "./useThrottledStoreSnapshot";

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

/**
 * 그래프 자체는 ChartStore → UPlotChart의 source 경로로 React를 거치지 않고 커밋되므로,
 * 여기서 리렌더가 필요한 건 헤더의 현재값 숫자뿐이다(축 단위/자리수는 축이 현재 줌 폭을
 * 보고 스스로 정한다 — uplot-option.ts). 프레임 도착 빈도(초당 100회 이상)와 무관하게
 * 공통 readout 주기로만 리렌더한다.
 */
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
    DEFAULT_STORE_READOUT_INTERVAL_MS,
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
