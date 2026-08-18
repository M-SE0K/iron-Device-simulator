"use client";

import { useCallback, useMemo } from "react";
import { DEFAULT_TEMP_WARN, DEFAULT_TEMP_DANGER } from "@/features/audio/lib/render/detect-events";
import { computeTemperatureYRange } from "@/features/audio/lib/render/chart-window";
import type { ChartStore } from "@/features/audio/lib/render/chart-store";
import type { AnnotationStore } from "@/features/audio/lib/render/annotation-store";
import { buildMetricChartOptions } from "@/features/audio/lib/render/metric-chart-options";
import { annotatePlugin, thresholdsPlugin } from "@/features/audio/lib/render/uplot-plugins";
import { useMetricChartRuntime } from "./hooks/useMetricChartRuntime";
import { useMetricChartSource } from "./hooks/useMetricChartSource";
import { useChartFullXRange } from "./hooks/useChartFullXRange";
import { useDrawMode } from "./hooks/useDrawMode";
import MetricChartCard from "./MetricChartCard";

interface Props {
  store: ChartStore;
  isActive: boolean;
  streaming?: boolean;
  audioDuration?: number | null;
  warnThreshold?: number;
  dangerThreshold?: number;
  annotations?: AnnotationStore;
  canAnnotate?: boolean;
}

const TEMP_COLOR = "#0B4171";

export default function TemperatureChart({
  store,
  isActive,
  streaming = false,
  audioDuration,
  warnThreshold = DEFAULT_TEMP_WARN,
  dangerThreshold = DEFAULT_TEMP_DANGER,
  annotations,
  canAnnotate = false,
}: Props) {
  const { isEnabled, draw } = useDrawMode(annotations, canAnnotate);
  const {
    current: currentTemp,
    showChart,
  } = useMetricChartRuntime({
    metric: "temperature",
    store,
    isActive,
    audioDuration,
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

  const getFullXRange = useChartFullXRange(store);
  const tooltipResolve = useCallback(
    (t: number) => store.valueAt("temperature", t),
    [store],
  );

  const options = useMemo(() => buildMetricChartOptions({
    series: {
      label: "Temperature",
      color: TEMP_COLOR,
      width: 2,
      spline: true,
      fill: ["rgba(11,65,113,0.18)", "rgba(11,65,113,0)"],
    },
    axisSize: 52,
    tooltipUnit: "°C",
    tooltipDecimals: 1,
    tooltipResolve,
    getFullXRange,
    extraPlugins: [
      thresholdsPlugin([
        { y: warnThreshold,   color: "#F59E0B", label: "WARN" },
        { y: dangerThreshold, color: "#EF4444", label: "DANGER" },
      ]),
      ...(annotations ? [annotatePlugin({ store: annotations, isEnabled })] : []),
    ],
  }), [warnThreshold, dangerThreshold, tooltipResolve, getFullXRange, annotations, isEnabled]);

  return (
    <MetricChartCard
      id="temperature-chart"
      title="Temperature"
      valueId="current-temperature-value"
      valueLabel={currentTemp !== null ? currentTemp.toFixed(1) : null}
      valueUnit="°C"
      valueColor={tempColor}
      showChart={showChart}
      audioDuration={audioDuration}
      streaming={streaming}
      options={options}
      source={source}
      draw={draw}
    />
  );
}
