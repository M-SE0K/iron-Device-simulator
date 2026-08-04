import { useCallback, useEffect, useRef } from "react";
import { perf } from "@/features/audio/lib/perf/collector";
import { e2e } from "@/features/audio/lib/perf-e2e/collector";
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
  perfTrack: boolean;
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
  perfTrack,
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

  // uPlot은 setData 안에서 동기적으로 캔버스를 다시 그린다 — UPlotChart가 그 구간을
  // 직접 측정해 ms로 보고하므로 그대로 기록한다. 상세 뷰의 두 번째 인스턴스는 같은
  // 커밋을 중복 계측하지 않도록 perfTrack이 꺼진 채로 마운트된다.
  const onRender = useCallback((ms: number) => {
    if (!perfTrack) return;
    // 이 콜백은 setData 직후 동기적으로 불린다 — 스토어 flush에서 화면 반영까지가 N11,
    // 캔버스 드로우 자체가 N12다. (읽기값 리렌더는 100ms로 throttle돼 있어 그쪽에서
    // 재면 throttle 지연이 그대로 섞인다.)
    e2e.sampleSinceCommit("N11", metric);
    perf.recordRender(metric, ms);
    e2e.sample("N12", ms, metric);
  }, [metric, perfTrack]);

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
    onRender,
    showChart: audioDuration != null || readout.hasPoints,
  };
}
