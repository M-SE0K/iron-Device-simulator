"use client";

import { useMemo } from "react";
import { DEFAULT_TEMP_WARN, DEFAULT_TEMP_DANGER } from "@/features/audio/lib/render/detect-events";
import { computeTemperatureYRange } from "@/features/audio/lib/render/chart-window";
import type { ChartStore } from "@/features/audio/lib/render/chart-store";
import type { AnnotationStore } from "@/features/audio/lib/render/annotation-store";
import { buildMetricChartOptions } from "@/features/audio/lib/render/metric-chart-options";
import { annotatePlugin, thresholdsPlugin } from "@/features/audio/lib/render/uplot-plugins";
import { useMetricChartRuntime } from "./hooks/useMetricChartRuntime";
import { useMetricChartSource } from "./hooks/useMetricChartSource";
import { useDrawMode } from "./hooks/useDrawMode";
import MetricChartCard from "./MetricChartCard";

interface Props {
  store: ChartStore;
  isActive: boolean;
  /** 재생 중일 때만 true — x축을 시계에 맞춰 균일하게 스크롤(60 Hz 버벅임 방지)하는 데 쓴다. */
  streaming?: boolean;
  audioDuration?: number | null;
  perfTrack?: boolean;
  warnThreshold?: number;
  dangerThreshold?: number;
  /** 점 잇기 주석 스토어 — 넘기면 정지 상태(canAnnotate)에서 헤더 연필 토글이 나타난다. */
  annotations?: AnnotationStore;
  /** 정지/재생 종료 상태 여부 — 재생 중에는 그리기 모드에 들어갈 수 없다. */
  canAnnotate?: boolean;
}

const TEMP_COLOR = "#0B4171";

export default function TemperatureChart({
  store,
  isActive,
  streaming = false,
  audioDuration,
  perfTrack = false,
  warnThreshold = DEFAULT_TEMP_WARN,
  dangerThreshold = DEFAULT_TEMP_DANGER,
  annotations,
  canAnnotate = false,
}: Props) {
  const { isEnabled, draw } = useDrawMode(annotations, canAnnotate);
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
    extraPlugins: [
      thresholdsPlugin([
        { y: warnThreshold,   color: "#F59E0B", label: "WARN" },
        { y: dangerThreshold, color: "#EF4444", label: "DANGER" },
      ]),
      ...(annotations ? [annotatePlugin({ store: annotations, isEnabled })] : []),
    ],
  }), [timeDecimals, warnThreshold, dangerThreshold, annotations, isEnabled]);

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
      onRender={onRender}
      draw={draw}
    />
  );
}
