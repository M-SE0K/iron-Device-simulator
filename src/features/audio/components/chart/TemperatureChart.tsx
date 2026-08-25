"use client";

import type { SpeakerFault } from "@/features/audio/types";
import { useMemo } from "react";
import { DEFAULT_TMAX } from "@/features/audio/lib/render/detect-events";
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
  /** 온도 한계(°C) — 임계선 + 헤더 색상 전환 기준 */
  tmax?: number;
  annotations?: AnnotationStore;
  canAnnotate?: boolean;
  speakerFault?: SpeakerFault | null;
}

const TEMP_COLOR = "#0B4171";

export default function TemperatureChart({
  store,
  isActive,
  streaming = false,
  audioDuration,
  tmax = DEFAULT_TMAX,
  annotations,
  canAnnotate = false,
  speakerFault = null,
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
    : currentTemp >= tmax ? "#EF4444"
    : TEMP_COLOR;

  const source = useMetricChartSource(
    store,
    "temperature",
    (snap) => computeTemperatureYRange(snap.tempMin, snap.tempMax),
  );

  const getFullXRange = useChartFullXRange(store);
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
    getFullXRange,
    extraPlugins: [
      thresholdsPlugin([
        { y: tmax, color: "#EF4444", label: "Tmax" },
      ]),
      ...(annotations ? [annotatePlugin({ store: annotations, isEnabled })] : []),
    ],
  }), [tmax, getFullXRange, annotations, isEnabled]);

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
      speakerFault={speakerFault}
    />
  );
}
