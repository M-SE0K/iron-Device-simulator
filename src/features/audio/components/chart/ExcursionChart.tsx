"use client";

import { useMemo } from "react";
import { toMm, MM_DECIMALS } from "@/features/audio/lib/units";
import { computeExcursionYRange } from "@/features/audio/lib/render/chart-window";
import type { ChartStore } from "@/features/audio/lib/render/chart-store";
import type { AnnotationStore } from "@/features/audio/lib/render/annotation-store";
import { buildMetricChartOptions } from "@/features/audio/lib/render/metric-chart-options";
import { annotatePlugin } from "@/features/audio/lib/render/uplot-plugins";
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
  annotations?: AnnotationStore;
  canAnnotate?: boolean;
  speakerOpen?: boolean;
}

const SCALE_PADDING = 1.15;

const EXC_COLOR = "#10B981";

export default function ExcursionChart({
  store,
  isActive,
  streaming = false,
  audioDuration,
  annotations,
  canAnnotate = false,
  speakerOpen = false,
}: Props) {
  const { isEnabled, draw } = useDrawMode(annotations, canAnnotate);
  const {
    current: currentExc,
    showChart,
  } = useMetricChartRuntime({
    metric: "excursion",
    store,
    isActive,
    audioDuration,
  });

  const { yMax } = computeExcursionYRange(
    store.snapshot().excMin, store.snapshot().excMax, toMm, SCALE_PADDING,
  );

  const excColor =
    currentExc !== null && Math.abs(toMm(currentExc)) > Math.abs(yMax) * 0.85
      ? "#EF4444"
      : EXC_COLOR;

  const source = useMetricChartSource(
    store,
    "excursion",
    (snap) => computeExcursionYRange(snap.excMin, snap.excMax, toMm, SCALE_PADDING),
    toMm,
  );

  const getFullXRange = useChartFullXRange(store);
  const options = useMemo(() => buildMetricChartOptions({
    series: {
      label: "Excursion",
      color: EXC_COLOR,
      width: 1.5,
      spline: true,
      fill: ["rgba(16,185,129,0.15)", "rgba(16,185,129,0)"],
      pointSize: 4,
    },
    axisSize: 60,
    tooltipUnit: "mm",
    tooltipDecimals: MM_DECIMALS,
    getFullXRange,
    extraPlugins: annotations ? [annotatePlugin({ store: annotations, isEnabled })] : undefined,
  }), [getFullXRange, annotations, isEnabled]);

  return (
    <MetricChartCard
      id="excursion-chart"
      title="Excursion"
      valueId="current-excursion-value"
      valueLabel={currentExc !== null ? toMm(currentExc).toFixed(MM_DECIMALS) : null}
      valueUnit="mm"
      unitClassName="text-iron-400"
      valueColor={excColor}
      showChart={showChart}
      audioDuration={audioDuration}
      streaming={streaming}
      options={options}
      source={source}
      draw={draw}
      speakerOpen={speakerOpen}
    />
  );
}
