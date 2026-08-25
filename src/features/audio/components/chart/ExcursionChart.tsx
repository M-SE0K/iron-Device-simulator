"use client";

import type { SpeakerFault } from "@/features/audio/types";
import { useMemo } from "react";
import { toMm, MM_DECIMALS } from "@/features/audio/lib/units";
import { computeExcursionYRange } from "@/features/audio/lib/render/chart-window";
import type { ChartStore } from "@/features/audio/lib/render/chart-store";
import type { AnnotationStore } from "@/features/audio/lib/render/annotation-store";
import { buildMetricChartOptions } from "@/features/audio/lib/render/metric-chart-options";
import { annotatePlugin, thresholdsPlugin } from "@/features/audio/lib/render/uplot-plugins";
import { DEFAULT_XMAX } from "@/features/audio/lib/render/detect-events";
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
  /** 변위 한계(mm) — ±임계선 + 헤더 색상 전환 기준 */
  xmax?: number;
  annotations?: AnnotationStore;
  canAnnotate?: boolean;
  speakerFault?: SpeakerFault | null;
}

const SCALE_PADDING = 1.15;

const EXC_COLOR = "#10B981";

export default function ExcursionChart({
  store,
  isActive,
  streaming = false,
  audioDuration,
  xmax = DEFAULT_XMAX,
  annotations,
  canAnnotate = false,
  speakerFault = null,
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

  /* Xmax를 넘어선 순간만 빨강 — 이전의 "현재 y축 범위 대비 85%" 휴리스틱은 스케일이
   * 데이터에 따라 움직여서 같은 변위인데도 색이 달라졌다. */
  const limit = Number.isFinite(xmax) && xmax > 0 ? xmax : null;
  const excColor =
    limit !== null && currentExc !== null && Math.abs(toMm(currentExc)) >= limit
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
    extraPlugins: [
      ...(limit !== null
        ? [thresholdsPlugin([
            { y:  limit, color: "#EF4444", label: "Xmax" },
            { y: -limit, color: "#EF4444", label: "-Xmax" },
          ])]
        : []),
      ...(annotations ? [annotatePlugin({ store: annotations, isEnabled })] : []),
    ],
  }), [limit, getFullXRange, annotations, isEnabled]);

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
      speakerFault={speakerFault}
    />
  );
}
