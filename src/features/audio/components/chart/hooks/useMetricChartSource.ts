import { useMemo, useRef } from "react";
import type uPlot from "uplot";
import type { UPlotDataSource } from "@/shared/components/UPlotChart";
import { createReadBuffer, SEED_PX_WIDTH, type SeriesReadBuffer } from "@/features/audio/lib/render/read-buffer";
import type { ChartMetric, ChartSnapshot, ChartStore } from "@/features/audio/lib/render/chart-store";

export function useMetricChartSource(
  store: ChartStore,
  metric: ChartMetric,
  computeYRange: (snap: ChartSnapshot) => { yMin: number; yMax: number },
  transform?: (v: number) => number,
): UPlotDataSource {
  const bufRef = useRef<SeriesReadBuffer | null>(null);

  return useMemo(() => ({
    subscribe: store.subscribe,
    read: (view) => {
      const snap = store.snapshot();
      const { yMin, yMax } = computeYRange(snap);
      const buf = (bufRef.current ??= createReadBuffer());

      const hasDomain = snap.firstX !== null && snap.lastX !== null && snap.lastX > snap.firstX;
      const xMin = view ? view.xMin : (snap.firstX ?? 0);
      const xMax = view && view.xMax > view.xMin ? view.xMax : (snap.lastX ?? 0);
      const columns = Math.max(1, Math.round(view?.pxWidth ?? SEED_PX_WIDTH));
      const count = store.readRange(metric, xMin, xMax, columns * 2 + 2, buf, transform);

      return {
        data: [buf.xs.subarray(0, count), buf.ys.subarray(0, count)] as unknown as uPlot.AlignedData,
        yRange: [yMin, yMax] as [number, number],
        ...(hasDomain ? { xFull: [snap.firstX!, snap.lastX!] as [number, number] } : {}),
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [store, metric, transform]);
}
