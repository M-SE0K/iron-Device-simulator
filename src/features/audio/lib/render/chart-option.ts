import type { AnalysisFrame } from "@/features/audio/types";

export interface ZoomState {
  start: number;
  end: number;
}

export type ZoomStateRef = { current: ZoomState };

export function extractZoomState(params: unknown): ZoomState | null {
  const event = params as {
    batch?: Array<{ start?: number; end?: number }>;
    start?: number;
    end?: number;
  };
  const source = event.batch?.[0] ?? event;
  if (source.start === undefined || source.end === undefined) return null;
  return { start: source.start, end: source.end };
}

const MAX_TIME_DECIMALS = 3;
const MIN_TIME_DECIMALS = 0;

export function timeDecimalsForInterval(intervalSec: number): number {
  if (!isFinite(intervalSec) || intervalSec <= 0) return MAX_TIME_DECIMALS;
  const decimals = Math.ceil(-Math.log10(intervalSec)) + 1;
  return Math.min(MAX_TIME_DECIMALS, Math.max(MIN_TIME_DECIMALS, decimals));
}

export function resolveTimeDecimals(windowFrames: AnalysisFrame[]): number {
  let minDelta = Infinity;
  for (let i = 1; i < windowFrames.length; i++) {
    const d = windowFrames[i].time - windowFrames[i - 1].time;
    if (d > 0 && d < minDelta) minDelta = d;
  }
  return timeDecimalsForInterval(minDelta);
}

function decimalsForVisibleSpan(spanSec: number): number {
  if (!isFinite(spanSec) || spanSec <= 0) return MAX_TIME_DECIMALS;
  if (spanSec >= 10) return 0;
  if (spanSec >= 1) return 1;
  if (spanSec >= 0.1) return 2;
  return MAX_TIME_DECIMALS;
}

function resolveDynamicDecimals(dataMin: number, dataMax: number, dataDecimals: number, zoom: ZoomState): number {
  const totalSpan = dataMax - dataMin;
  const visibleSpan = totalSpan * Math.max(0, zoom.end - zoom.start) / 100;
  const spanDecimals = decimalsForVisibleSpan(visibleSpan);
  const effectiveMax = Math.min(dataDecimals, MAX_TIME_DECIMALS);
  return Math.min(effectiveMax, Math.max(MIN_TIME_DECIMALS, spanDecimals));
}

function floorFixed(v: number, decimals: number): string {
  const factor = 10 ** decimals;
  const floored = Math.floor(v * factor + 1e-9) / factor;
  return floored.toFixed(decimals);
}

export function buildDynamicTimeFormatter(
  zoomRef: ZoomStateRef,
  domain: { dataMin: number; dataMax: number; dataDecimals: number },
) {
  const { dataMin, dataMax, dataDecimals } = domain;
  return (v: number) => `${floorFixed(v, resolveDynamicDecimals(dataMin, dataMax, dataDecimals, zoomRef.current))}s`;
}

export function buildDataZoom(
  zoomRef: ZoomStateRef,
  colors: { filler: string; handle: string },
  domain: { dataMin: number; dataMax: number; dataDecimals: number },
) {
  const zoom = zoomRef.current;
  const labelFormatter = buildDynamicTimeFormatter(zoomRef, domain);
  return [
    {
      type: "inside" as const,
      xAxisIndex: 0,
      filterMode: "filter" as const,
      start: zoom.start,
      end: zoom.end,
      zoomOnMouseWheel: true,
      moveOnMouseMove: true,
      moveOnMouseWheel: false,
    },
    {
      type: "slider" as const,
      xAxisIndex: 0,
      height: 16,
      bottom: 4,
      start: zoom.start,
      end: zoom.end,
      borderColor: "#E2E8F0",
      backgroundColor: "#F1F5F9",
      fillerColor: colors.filler,
      handleStyle: { color: colors.handle, borderColor: colors.handle },
      moveHandleStyle: { color: colors.handle },
      textStyle: { color: "#94A3B8", fontSize: 9 },
      labelFormatter,
    },
  ];
}

function buildTimeAxis(opts: {
  windowFrames: AnalysisFrame[];
  zoomRef: ZoomStateRef;
}) {
  const { windowFrames, zoomRef } = opts;
  const dataMin = 0;
  const dataMax = windowFrames[windowFrames.length - 1]?.time ?? 10;
  const dataDecimals = resolveTimeDecimals(windowFrames);
  return {
    type: "value" as const,
    min: dataMin,
    max: dataMax,
    axisLabel: {
      formatter: buildDynamicTimeFormatter(zoomRef, { dataMin, dataMax, dataDecimals }),
      color: "#94A3B8",
      fontSize: 10,
    },
    axisLine: { lineStyle: { color: "#E2E8F0" } },
    splitLine: { lineStyle: { color: "#F1F5F9" } },
  };
}

export function buildValueTooltip(opts: { unit: string; decimals: number; timeDecimals?: number }) {
  const { unit, decimals, timeDecimals = MAX_TIME_DECIMALS } = opts;
  return {
    trigger: "axis" as const,
    backgroundColor: "#0F172A",
    borderColor: "#1E293B",
    textStyle: { color: "#F1F5F9", fontSize: 11, fontFamily: "JetBrains Mono" },
    formatter: (params: { seriesName: string; data: [number, number] }[]) => {
      const t = params[0].data[0];
      const lines = params.map((p) => `${p.seriesName}: <b>${p.data[1].toFixed(decimals)} ${unit}</b>`);
      return `${t.toFixed(timeDecimals)}s<br/>${lines.join("<br/>")}`;
    },
  };
}

export const SYMBOL_VISIBLE_MAX = 80;

export function shouldShowFrameSymbols(pointCount: number, zoom: ZoomState): boolean {
  const visible = pointCount * Math.max(0, zoom.end - zoom.start) / 100;
  return visible > 0 && visible <= SYMBOL_VISIBLE_MAX;
}

export function buildAreaGradient(topColor: string, bottomColor: string) {
  return {
    color: {
      type: "linear" as const, x: 0, y: 0, x2: 0, y2: 1,
      colorStops: [
        { offset: 0, color: topColor },
        { offset: 1, color: bottomColor },
      ],
    },
  };
}

export function buildValueYAxis(opts: {
  name: string;
  min: number;
  max: number;
  labelFormatter?: (v: number) => string;
}) {
  return {
    type: "value" as const,
    name: opts.name,
    nameTextStyle: { color: "#94A3B8", fontSize: 10 },
    axisLabel: {
      color: "#94A3B8",
      fontSize: 10,
      ...(opts.labelFormatter ? { formatter: opts.labelFormatter } : {}),
    },
    axisLine: { show: false },
    splitLine: { lineStyle: { color: "#F1F5F9" } },
    min: opts.min,
    max: opts.max,
  };
}

export function buildLineSeries(opts: {
  name: string;
  data: number[][];
  color: string;
  smooth: number | boolean;
  width: number;
  sampling: Record<string, unknown>;
  area?: object;
  markLine?: object;
  showSymbol?: boolean;
  symbolSize?: number;
}) {
  const showSymbol = opts.showSymbol ?? false;
  return {
    name: opts.name,
    type: "line" as const,
    data: opts.data,
    smooth: opts.smooth,
    symbol: showSymbol ? "circle" : "none",
    showSymbol,
    symbolSize: opts.symbolSize ?? 4,
    itemStyle: { color: opts.color },
    ...(showSymbol ? {} : opts.sampling),
    lineStyle: { color: opts.color, width: opts.width },
    areaStyle: opts.area,
    ...(opts.markLine !== undefined ? { markLine: opts.markLine } : {}),
  };
}

export function buildBaseChartOption(opts: {
  windowFrames: AnalysisFrame[];
  zoomRef: ZoomStateRef;
  gridLeft: number;
  zoomColors: { filler: string; handle: string };
  timeDecimals: number;
  yAxis: object;
  series: object[];
  tooltip: object;
}) {
  return {
    animation: false,
    grid: { top: 8, right: 16, bottom: 52, left: opts.gridLeft },
    legend: { show: false as const },
    dataZoom: buildDataZoom(opts.zoomRef, opts.zoomColors, {
      dataMin: 0,
      dataMax: opts.windowFrames[opts.windowFrames.length - 1]?.time ?? 10,
      dataDecimals: opts.timeDecimals,
    }),
    xAxis: buildTimeAxis({ windowFrames: opts.windowFrames, zoomRef: opts.zoomRef }),
    yAxis: opts.yAxis,
    series: opts.series,
    tooltip: opts.tooltip,
  };
}
