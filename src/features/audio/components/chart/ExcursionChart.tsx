"use client";

import { useMemo } from "react";
import { Maximize2 } from "lucide-react";
import uPlot from "uplot";
import { AnalysisFrame } from "@/features/audio/types";
import UPlotChart, { type UPlotOptions } from "@/shared/components/UPlotChart";
import { toMm, MM_DECIMALS } from "@/features/audio/lib/units";
import { computeExcursionYRange } from "@/features/audio/lib/render/chart-window";
import {
  buildAreaFill, buildTimeAxis, buildValueAxis, resolveTimeDecimals, toAlignedData,
} from "@/features/audio/lib/render/uplot-option";
import { tooltipPlugin, zoomPlugin } from "@/features/audio/lib/render/uplot-plugins";
import { useMetricChartRuntime } from "./hooks/useMetricChartRuntime";

interface Props {
  frames: AnalysisFrame[];
  isActive: boolean;
  audioDuration?: number | null;
  perfTrack?: boolean;
  onExpand?: () => void;
}

const SCALE_PADDING = 1.15;

const EXC_COLOR = "#10B981";

export default function ExcursionChart({ frames, isActive, audioDuration, perfTrack = false, onExpand }: Props) {
  const {
    current: currentExc,
    windowFrames,
    onRender,
    showChart,
  } = useMetricChartRuntime({
    metric: "excursion",
    frames,
    isActive,
    audioDuration,
    perfTrack,
  });

  const { yMin, yMax } = useMemo(
    () => computeExcursionYRange(windowFrames, toMm, SCALE_PADDING),
    [windowFrames],
  );

  const displayExc = currentExc;

  const excColor =
    displayExc !== null && Math.abs(toMm(displayExc)) > Math.abs(yMax) * 0.85
      ? "#EF4444"
      : EXC_COLOR;

  const data = useMemo(
    () => toAlignedData(windowFrames, (f) => toMm(f.excursion)),
    [windowFrames],
  );

  const timeDecimals = resolveTimeDecimals(windowFrames);

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
            data={data}
            yRange={[yMin, yMax]}
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
