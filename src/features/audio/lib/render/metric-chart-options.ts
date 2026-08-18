import "@/shared/lib/dpr-cap";
import uPlot from "uplot";
import type { UPlotOptions } from "@/shared/components/UPlotChart";
import { buildAreaFill, buildTimeAxis, buildValueAxis } from "./uplot-option";
import { tooltipPlugin, zoomPlugin } from "./uplot-plugins";

interface MetricSeriesStyle {
  label: string;
  color: string;
  width: number;
  spline?: boolean;
  fill?: [top: string, bottom: string];
  pointSize?: number;
}

export interface MetricChartOptionsConfig {
  series: MetricSeriesStyle;
  axisSize: number;
  tooltipUnit: string;
  tooltipDecimals: number;
  tooltipResolve?: (timeSec: number) => number | null;
  getFullXRange?: () => [number, number] | null;
  extraPlugins?: uPlot.Plugin[];
}

export function buildMetricChartOptions(config: MetricChartOptionsConfig): UPlotOptions {
  const {
    series, axisSize, tooltipUnit, tooltipDecimals, tooltipResolve, getFullXRange, extraPlugins,
  } = config;
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
    axes: [buildTimeAxis(), buildValueAxis({ size: axisSize })],
    plugins: [
      zoomPlugin({ getFullXRange }),
      tooltipPlugin({
        unit: tooltipUnit,
        decimals: tooltipDecimals,
        ...(tooltipResolve
          ? { virtualSeries: [{ label: series.label, seriesIdx: 1, resolve: tooltipResolve }] }
          : {}),
      }),
      ...(extraPlugins ?? []),
    ],
  };
}
