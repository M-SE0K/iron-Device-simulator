"use client";

import { useMemo } from "react";
import { Maximize2 } from "lucide-react";
import uPlot from "uplot";
import { AnalysisFrame } from "@/features/audio/types";
import UPlotChart, { type UPlotOptions } from "@/shared/components/UPlotChart";
import { DEFAULT_TEMP_WARN, DEFAULT_TEMP_DANGER } from "@/features/audio/lib/render/detect-events";
import { computeTemperatureYRange } from "@/features/audio/lib/render/chart-window";
import {
  buildAreaFill, buildTimeAxis, buildValueAxis, resolveTimeDecimals, toAlignedData,
} from "@/features/audio/lib/render/uplot-option";
import { thresholdsPlugin, tooltipPlugin, zoomPlugin } from "@/features/audio/lib/render/uplot-plugins";
import { useMetricChartRuntime } from "./hooks/useMetricChartRuntime";

interface Props {
  frames: AnalysisFrame[];
  isActive: boolean;
  /** 재생 중일 때만 true — x축을 시계에 맞춰 균일하게 스크롤(60 Hz 버벅임 방지)하는 데 쓴다. */
  streaming?: boolean;
  audioDuration?: number | null;
  perfTrack?: boolean;
  onExpand?: () => void;
  warnThreshold?: number;
  dangerThreshold?: number;
}

const TEMP_COLOR = "#0B4171";

export default function TemperatureChart({ frames, isActive, streaming = false, audioDuration, perfTrack = false, onExpand, warnThreshold = DEFAULT_TEMP_WARN, dangerThreshold = DEFAULT_TEMP_DANGER }: Props) {
  const {
    current: currentTemp,
    windowFrames,
    onRender,
    showChart,
  } = useMetricChartRuntime({
    metric: "temperature",
    frames,
    isActive,
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

  const data = useMemo(
    () => toAlignedData(windowFrames, (f) => f.temperature),
    [windowFrames],
  );

  const timeDecimals = resolveTimeDecimals(windowFrames);

  const options = useMemo<UPlotOptions>(() => ({
    legend: { show: false },
    cursor: { drag: { x: true, y: false } },
    series: [
      {},
      {
        label: "Temperature",
        stroke: TEMP_COLOR,
        width: 2,
        fill: buildAreaFill("rgba(11,65,113,0.18)", "rgba(11,65,113,0)"),
        paths: uPlot.paths.spline!(),
        points: { size: 5, fill: TEMP_COLOR },
      },
    ],
    axes: [buildTimeAxis(timeDecimals), buildValueAxis({ size: 52 })],
    plugins: [
      zoomPlugin(),
      tooltipPlugin({ unit: "°C", decimals: 1, timeDecimals }),
      thresholdsPlugin([
        { y: warnThreshold,   color: "#F59E0B", label: "WARN" },
        { y: dangerThreshold, color: "#EF4444", label: "DANGER" },
      ]),
    ],
  }), [timeDecimals, warnThreshold, dangerThreshold]);

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
          <UPlotChart
            key={audioDuration ?? "live"}
            options={options}
            data={data}
            yRange={[yMin, yMax]}
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
