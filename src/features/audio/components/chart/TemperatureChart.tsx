"use client";

import { useMemo } from "react";
import { Maximize2 } from "lucide-react";
import { AnalysisFrame } from "@/features/audio/types";
import ReactECharts from "@/shared/components/ReactECharts";
import { DEFAULT_TEMP_WARN, DEFAULT_TEMP_DANGER } from "@/features/audio/lib/render/detect-events";
import { computeTemperatureYRange } from "@/features/audio/lib/render/chart-window";
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
  warnThreshold?: number;
  dangerThreshold?: number;
}

const TEMP_COLOR = "#0B4171";

export default function TemperatureChart({ frames, currentTime, isActive, streaming = false, audioDuration, lttb = true, perfTrack = false, onExpand, warnThreshold = DEFAULT_TEMP_WARN, dangerThreshold = DEFAULT_TEMP_DANGER }: Props) {
  const {
    current: currentTemp,
    windowFrames,
    zoomRef,
    showSymbols,
    echartsEvents,
    showChart,
  } = useMetricChartRuntime({
    metric: "temperature",
    frames,
    currentTime,
    isActive,
    streaming,
    audioDuration,
    perfTrack,
  });

  const displayTemp = currentTemp;

  const tempColor =
    displayTemp === null ? "#94A3B8"
    : displayTemp >= dangerThreshold ? "#EF4444"
    : displayTemp >= warnThreshold   ? "#F59E0B"
    : TEMP_COLOR;

  const { yMin, yMax } = useMemo(
    () => computeTemperatureYRange(windowFrames),
    [windowFrames],
  );

  const option = useMemo(() => {
    const samplingOpts = lttb ? { sampling: "lttb", large: true, largeThreshold: 2000 } : {};
    const timeDecimals = resolveTimeDecimals(windowFrames);

    const markLine = {
      silent: true,
      symbol: "none",
      data: [
        { yAxis: warnThreshold,   lineStyle: { color: "#F59E0B", type: "dashed", width: 1 }, label: { formatter: "WARN",   color: "#F59E0B", fontSize: 9 } },
        { yAxis: dangerThreshold, lineStyle: { color: "#EF4444", type: "dashed", width: 1 }, label: { formatter: "DANGER", color: "#EF4444", fontSize: 9 } },
      ],
    };

    const series = buildLineSeries({
      name: "Temperature",
      data: windowFrames.map((f) => [f.time, f.temperature]),
      color: TEMP_COLOR, smooth: true, width: 2, sampling: samplingOpts,
      area: buildAreaGradient("rgba(11,65,113,0.18)", "rgba(11,65,113,0)"),
      markLine, showSymbol: showSymbols, symbolSize: 5,
    });

    return buildBaseChartOption({
      windowFrames, zoomRef, gridLeft: 52,
      zoomColors: { filler: "rgba(11,65,113,0.12)", handle: "#0B4171" },
      timeDecimals,
      yAxis: buildValueYAxis({ name: "°C", min: yMin, max: yMax }),
      series: [series],
      tooltip: buildValueTooltip({ unit: "°C", decimals: 1, timeDecimals }),
    });
  }, [windowFrames, zoomRef, yMin, yMax, lttb, warnThreshold, dangerThreshold, showSymbols]);

  return (
    <div id="temperature-chart" className="card flex flex-col h-full">
      <div className="card-header">
        <div className="chart-title-group flex items-center gap-2">
          <span className="card-title">Temperature</span>
          {onExpand && (
            <button
              type="button"
              onClick={onExpand}
              aria-label="Temperature chart detail view"
              title="View details"
              className="ml-0.5 p-1 rounded text-iron-300 hover:text-brand-blue hover:bg-brand-blue/5 transition-colors"
            >
              <Maximize2 size={13} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {displayTemp !== null ? (
            <span id="current-temperature-value" className="font-mono text-lg font-semibold" style={{ color: tempColor }}>
              {displayTemp.toFixed(1)}<span className="text-xs ml-0.5 font-normal">°C</span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="chart-body flex-1 p-2 min-h-[160px]">
        {showChart ? (
          <ReactECharts
            option={option}
            style={{ height: "100%", width: "100%" }}
            notMerge={false}
            onEvents={echartsEvents}
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
