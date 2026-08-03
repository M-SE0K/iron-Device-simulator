import { useMemo } from "react";
import type uPlot from "uplot";
import type { UPlotDataSource } from "@/shared/components/UPlotChart";
import type { ChartMetric, ChartSnapshot, ChartStore } from "@/features/audio/lib/render/chart-store";

/**
 * Temperature/ExcursionChart가 공유하는 uPlot 데이터 소스 — React 상태를 거치지 않고
 * ChartStore에서 직접 읽어 uPlot에 커밋한다(구독은 store.subscribe, 커밋 페이로드는 매
 * rAF마다 read()가 새로 만든다). 두 차트가 다른 건 어떤 메트릭 컬럼을 읽는지(metric),
 * 값 변환이 필요한지(transform — Excursion의 mm 변환), y축 범위를 어떻게 계산하는지
 * (computeYRange)뿐이다.
 *
 * computeYRange/transform은 의존성 배열에 넣지 않는다 — 두 차트 모두 렌더마다 새 클로저를
 * 넘기지만 그 안에서 참조하는 값(toMm, SCALE_PADDING 등)은 모듈 상수라 클로저 정체성이
 * 바뀌어도 동작은 항상 같다. read()는 UPlotChart가 ref로만 호출하므로 최신 결과가 필요할
 * 때마다 다시 실행된다 — memo가 갱신되지 않아도 stale 값을 반환하지 않는다.
 */
export function useMetricChartSource(
  store: ChartStore,
  metric: ChartMetric,
  computeYRange: (snap: ChartSnapshot) => { yMin: number; yMax: number },
  transform?: (v: number) => number,
): UPlotDataSource {
  return useMemo(() => ({
    subscribe: store.subscribe,
    read: () => {
      // count가 0이어도 빈 데이터를 그대로 커밋한다 — 세션 리셋 시 캔버스가 비워져야 한다.
      const snap = store.snapshot();
      const { yMin, yMax } = computeYRange(snap);
      return {
        data: store.readAligned(metric, transform) as unknown as uPlot.AlignedData,
        yRange: [yMin, yMax] as [number, number],
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [store, metric, transform]);
}
