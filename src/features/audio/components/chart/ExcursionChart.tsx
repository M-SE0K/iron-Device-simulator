"use client";

import { useMemo } from "react";
import { Maximize2 } from "lucide-react";
import { AnalysisFrame } from "@/features/audio/types";
import ReactECharts from "@/shared/components/ReactECharts";
import { toMm, MM_DECIMALS } from "@/features/audio/lib/units";
import { computeExcursionYRange } from "@/features/audio/lib/render/chart-window";
import {
  buildValueTooltip, resolveTimeDecimals,
  buildAreaGradient, buildValueYAxis, buildLineSeries, buildBaseChartOption,
} from "@/features/audio/lib/render/chart-option";
import { useMetricChartRuntime } from "./hooks/useMetricChartRuntime";

interface Props {
  frames: AnalysisFrame[];
  currentTime: number;
  isActive: boolean;
  streaming?: boolean;
  audioDuration?: number | null;
  lttb?: boolean;
  perfTrack?: boolean;
  onExpand?: () => void;
}

const SCALE_PADDING = 1.15;

const EXC_COLOR = "#10B981";

export default function ExcursionChart({ frames, currentTime, isActive, streaming = false, audioDuration, lttb = true, perfTrack = false, onExpand }: Props) {
  const {
    current: currentExc,
    windowFrames,
    zoomRef,
    showSymbols,
    echartsEvents,
    showChart,
  } = useMetricChartRuntime({
    metric: "excursion",
    frames,
    currentTime,
    isActive,
    streaming,
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

  const option = useMemo(() => {
    const samplingOpts = lttb ? { sampling: "lttb" as const, large: true, largeThreshold: 2000 } : {};
    const timeDecimals = resolveTimeDecimals(windowFrames);

    const series = buildLineSeries({
      name: "Excursion",
      data: windowFrames.map((f) => [f.time, toMm(f.excursion)]),
      color: EXC_COLOR, smooth: 0.3, width: 1.5, sampling: samplingOpts,
      area: buildAreaGradient("rgba(16,185,129,0.15)", "rgba(16,185,129,0)"),
      showSymbol: showSymbols, symbolSize: 4,
    });

    return buildBaseChartOption({
      windowFrames, zoomRef, gridLeft: 60,
      zoomColors: { filler: "rgba(16,185,129,0.12)", handle: "#10B981" },
      timeDecimals,
      yAxis: buildValueYAxis({ name: "mm", min: yMin, max: yMax, labelFormatter: (v: number) => v.toFixed(MM_DECIMALS) }),
      series: [series],
      tooltip: buildValueTooltip({ unit: "mm", decimals: MM_DECIMALS, timeDecimals }),
    });
  }, [windowFrames, zoomRef, yMin, yMax, lttb, showSymbols]);

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
          <ReactECharts option={option} style={{ height: "100%", width: "100%" }} notMerge={false} onEvents={echartsEvents} />
        ) : (
          <div className="chart-empty-state h-full flex items-center justify-center text-xs text-iron-300">
            Data will appear here in real time during playback
          </div>
        )}
      </div>
    </div>
  );
}
