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
import { useDrawMode } from "./hooks/useDrawMode";
import MetricChartCard from "./MetricChartCard";

interface Props {
  store: ChartStore;
  isActive: boolean;
  /** 재생 중일 때만 true — x축을 시계에 맞춰 균일하게 스크롤(60 Hz 버벅임 방지)하는 데 쓴다. */
  streaming?: boolean;
  audioDuration?: number | null;
  /** 점 잇기 주석 스토어 — 넘기면 정지 상태(canAnnotate)에서 헤더 연필 토글이 나타난다. */
  annotations?: AnnotationStore;
  /** 정지/재생 종료 상태 여부 — 재생 중에는 그리기 모드에 들어갈 수 없다. */
  canAnnotate?: boolean;
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

  // 헤더 색상 판정에만 쓰는 y 상한 — 실제 축 범위는 source.read()가 커밋 시점에 정한다.
  // snapshot()은 버전별로 캐시된 스칼라라 렌더마다 읽어도 비용이 없다.
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
    axisFormatter: (v: number) => v.toFixed(MM_DECIMALS),
    tooltipUnit: "mm",
    tooltipDecimals: MM_DECIMALS,
    extraPlugins: annotations ? [annotatePlugin({ store: annotations, isEnabled })] : undefined,
  }), [annotations, isEnabled]);

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
    />
  );
}
