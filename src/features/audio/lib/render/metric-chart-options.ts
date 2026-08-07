import uPlot from "uplot";
import type { UPlotOptions } from "@/shared/components/UPlotChart";
import { buildAreaFill, buildTimeAxis, buildValueAxis } from "./uplot-option";
import { tooltipPlugin, zoomPlugin } from "./uplot-plugins";

/**
 * Temperature/ExcursionChart가 공유하는 uPlot 시리즈/옵션 빌더 — legend/cursor/축/기본
 * 플러그인(zoom+tooltip) 구성은 두 차트가 항상 동일하고, 시리즈 스타일과 메트릭별 추가
 * 플러그인(예: 온도의 WARN/DANGER 임계선)만 다르다. 이 차이만 config로 받는다.
 */
interface MetricSeriesStyle {
  label: string;
  color: string;
  width: number;
  /** 부드러운 곡선(spline) 보간. 생략하면 uPlot 기본(직선) 경로를 쓴다. */
  spline?: boolean;
  /** 선 아래 면적 그라디언트 [위, 아래] 색상. 생략하면 채우지 않는다. */
  fill?: [top: string, bottom: string];
  /** 커서 포인트 반지름(px). 생략 시 5. */
  pointSize?: number;
}

export interface MetricChartOptionsConfig {
  series: MetricSeriesStyle;
  axisSize: number;
  axisFormatter?: (v: number) => string;
  tooltipUnit: string;
  tooltipDecimals: number;
  /** thresholdsPlugin 등 메트릭별 추가 플러그인 — 기본 zoom/tooltip 뒤에 붙는다. */
  extraPlugins?: uPlot.Plugin[];
}

export function buildMetricChartOptions(config: MetricChartOptionsConfig): UPlotOptions {
  const { series, axisSize, axisFormatter, tooltipUnit, tooltipDecimals, extraPlugins } = config;
  return {
    legend: { show: false },
    cursor: { drag: { x: true, y: false } },
    series: [
      {},
      {
        label: series.label,
        stroke: series.color,
        width: series.width,
        ...(series.fill ? { fill: buildAreaFill(series.fill[0], series.fill[1]) } : {}),
        ...(series.spline ? { paths: uPlot.paths.spline!() } : {}),
        points: { size: series.pointSize ?? 5, fill: series.color },
      },
    ],
    axes: [buildTimeAxis(), buildValueAxis({ size: axisSize, formatter: axisFormatter })],
    plugins: [
      zoomPlugin(),
      tooltipPlugin({ unit: tooltipUnit, decimals: tooltipDecimals }),
      ...(extraPlugins ?? []),
    ],
  };
}
