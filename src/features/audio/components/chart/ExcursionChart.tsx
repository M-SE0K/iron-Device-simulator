"use client";

import { useMemo } from "react";
import { Maximize2 } from "lucide-react";
import uPlot from "uplot";
import UPlotChart, { type UPlotDataSource, type UPlotOptions } from "@/shared/components/UPlotChart";
import { toMm, MM_DECIMALS } from "@/features/audio/lib/units";
import { computeExcursionYRange } from "@/features/audio/lib/render/chart-window";
import type { ChartStore } from "@/features/audio/lib/render/chart-store";
import {
  buildAreaFill, buildTimeAxis, buildValueAxis,
} from "@/features/audio/lib/render/uplot-option";
import { tooltipPlugin, zoomPlugin } from "@/features/audio/lib/render/uplot-plugins";
import { useMetricChartRuntime } from "./hooks/useMetricChartRuntime";

interface Props {
  store: ChartStore;
  isActive: boolean;
  /** 재생 중일 때만 true — x축을 시계에 맞춰 균일하게 스크롤(60 Hz 버벅임 방지)하는 데 쓴다. */
  streaming?: boolean;
  audioDuration?: number | null;
  perfTrack?: boolean;
  onExpand?: () => void;
}

const SCALE_PADDING = 1.15;

const EXC_COLOR = "#10B981";

export default function ExcursionChart({ store, isActive, streaming = false, audioDuration, perfTrack = false, onExpand }: Props) {
  const {
    current: currentExc,
    timeDecimals,
    onRender,
    showChart,
  } = useMetricChartRuntime({
    metric: "excursion",
    store,
    isActive,
    audioDuration,
    perfTrack,
  });

  const displayExc = currentExc;

  // 헤더 색상 판정에만 쓰는 y 상한 — 실제 축 범위는 아래 source.read()가 커밋 시점에 정한다.
  // snapshot()은 버전별로 캐시된 스칼라라 렌더마다 읽어도 비용이 없다.
  const { yMax } = computeExcursionYRange(
    store.snapshot().excMin, store.snapshot().excMax, toMm, SCALE_PADDING,
  );

  const excColor =
    displayExc !== null && Math.abs(toMm(displayExc)) > Math.abs(yMax) * 0.85
      ? "#EF4444"
      : EXC_COLOR;

  // 데이터/y축은 React 상태를 거치지 않고 스토어에서 직접 읽어 uPlot에 커밋한다.
  const source = useMemo<UPlotDataSource>(() => ({
    subscribe: store.subscribe,
    read: () => {
      // count가 0이어도 빈 데이터를 그대로 커밋한다 — 세션 리셋 시 캔버스가 비워져야 한다.
      const snap = store.snapshot();
      const range = computeExcursionYRange(snap.excMin, snap.excMax, toMm, SCALE_PADDING);
      return {
        data: store.readAligned("excursion", toMm) as unknown as uPlot.AlignedData,
        yRange: [range.yMin, range.yMax],
      };
    },
  }), [store]);

  const options = useMemo<UPlotOptions>(() => ({
    legend: { show: false },
    cursor: { drag: { x: true, y: false } },
    series: [
      {},
      {
        label: "Excursion",
        stroke: EXC_COLOR,
        width: 1.5,
        fill: buildAreaFill("rgba(16,185,129,0.15)", "rgba(16,185,129,0)"),
        paths: uPlot.paths.spline!(),
        points: { size: 4, fill: EXC_COLOR },
      },
    ],
    axes: [
      buildTimeAxis(timeDecimals),
      buildValueAxis({ size: 60, formatter: (v: number) => v.toFixed(MM_DECIMALS) }),
    ],
    plugins: [
      zoomPlugin(),
      tooltipPlugin({ unit: "mm", decimals: MM_DECIMALS, timeDecimals }),
    ],
  }), [timeDecimals]);

  return (
    <div id="excursion-chart" className="card flex flex-col h-full">
      <div className="card-header">
        <div className="chart-title-group flex items-center gap-2">
          <span className="card-title">Excursion</span>
          {onExpand && (
            <button
              type="button"
              onClick={onExpand}
              aria-label="Excursion chart detail view"
              title="View details"
              className="ml-0.5 p-1 rounded text-iron-300 hover:text-emerald-600 hover:bg-emerald-50 transition-colors"
            >
              <Maximize2 size={13} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {displayExc !== null ? (
            <span id="current-excursion-value" className="font-mono text-lg font-semibold" style={{ color: excColor }}>
              {toMm(displayExc).toFixed(MM_DECIMALS)}<span className="text-xs ml-0.5 font-normal text-iron-400">mm</span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="chart-body flex-1 p-2 min-h-[160px]">
        {showChart ? (
          <UPlotChart
            key={audioDuration ?? "live"}
            options={options}
            source={source}
            streamFollow={streaming}
            onRender={onRender}
          />
        ) : (
          <div className="chart-empty-state h-full flex items-center justify-center text-xs text-iron-300">
            Data will appear here in real time during playback
          </div>
        )}
      </div>
    </div>
  );
}
