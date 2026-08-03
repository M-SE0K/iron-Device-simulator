"use client";

import { useMemo } from "react";
import { DEFAULT_TEMP_WARN, DEFAULT_TEMP_DANGER } from "@/features/audio/lib/render/detect-events";
import { computeTemperatureYRange } from "@/features/audio/lib/render/chart-window";
import type { ChartStore } from "@/features/audio/lib/render/chart-store";
import { buildMetricChartOptions } from "@/features/audio/lib/render/metric-chart-options";
import { thresholdsPlugin } from "@/features/audio/lib/render/uplot-plugins";
import { useMetricChartRuntime } from "./hooks/useMetricChartRuntime";
import { useMetricChartSource } from "./hooks/useMetricChartSource";
import MetricChartCard from "./MetricChartCard";

interface Props {
  store: ChartStore;
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

export default function TemperatureChart({
  store,
  isActive,
  streaming = false,
  audioDuration,
  perfTrack = false,
  onExpand,
  warnThreshold = DEFAULT_TEMP_WARN,
  dangerThreshold = DEFAULT_TEMP_DANGER,
}: Props) {
  const {
    current: currentTemp,
    timeDecimals,
    onRender,
    showChart,
  } = useMetricChartRuntime({
    metric: "temperature",
    store,
    isActive,
    audioDuration,
    perfTrack,
  });

  const tempColor =
    currentTemp === null ? "#94A3B8"
    : currentTemp >= dangerThreshold ? "#EF4444"
    : currentTemp >= warnThreshold   ? "#F59E0B"
    : TEMP_COLOR;

  const source = useMetricChartSource(
    store,
    "temperature",
    (snap) => computeTemperatureYRange(snap.tempMin, snap.tempMax),
  );

  const options = useMemo(() => buildMetricChartOptions({
    series: {
      label: "Temperature",
      color: TEMP_COLOR,
      width: 2,
      spline: true,
      fill: ["rgba(11,65,113,0.18)", "rgba(11,65,113,0)"],
    },
    timeDecimals,
    axisSize: 52,
    tooltipUnit: "°C",
    tooltipDecimals: 1,
    extraPlugins: [thresholdsPlugin([
      { y: warnThreshold,   color: "#F59E0B", label: "WARN" },
      { y: dangerThreshold, color: "#EF4444", label: "DANGER" },
    ])],
  }), [timeDecimals, warnThreshold, dangerThreshold]);

  return (
    <MetricChartCard
      id="temperature-chart"
      title="Temperature"
      expandAriaLabel="Temperature chart detail view"
      expandHoverClassName="hover:text-brand-blue hover:bg-brand-blue/5"
      onExpand={onExpand}
      valueId="current-temperature-value"
      valueLabel={currentTemp !== null ? currentTemp.toFixed(1) : null}
      valueUnit="°C"
      valueColor={tempColor}
      showChart={showChart}
      audioDuration={audioDuration}
      streaming={streaming}
      options={options}
      source={source}
      onRender={onRender}
    />
  );
}
