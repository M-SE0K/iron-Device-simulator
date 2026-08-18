import type uPlot from "uplot";

const AXIS_LABEL_COLOR = "#94A3B8";
const AXIS_LINE_COLOR = "#E2E8F0";
const GRID_COLOR = "#F1F5F9";
const AXIS_FONT = "10px system-ui, -apple-system, sans-serif";

const MAX_DECIMALS = 6;
const MIN_DECIMALS = 0;

function decimalsForSpan(span: number): number {
  if (!isFinite(span) || span <= 0) return 3;
  const decimals = Math.ceil(-Math.log10(span)) + 1;
  return Math.min(MAX_DECIMALS, Math.max(MIN_DECIMALS, decimals));
}

export function formatTimeValue(value: number, decimals: number): string {
  return `${value.toFixed(decimals)}s`;
}

export function timeDecimalsForScale(u: uPlot): number {
  return decimalsForSpan((u.scales.x.max ?? 0) - (u.scales.x.min ?? 0));
}

export function valueDecimalsForScale(u: uPlot): number {
  return decimalsForSpan((u.scales.y.max ?? 0) - (u.scales.y.min ?? 0));
}

export function buildTimeAxis(): uPlot.Axis {
  return {
    stroke: AXIS_LABEL_COLOR,
    font: AXIS_FONT,
    gap: 4,
    size: 28,
    grid: { stroke: GRID_COLOR, width: 1 },
    ticks: { stroke: AXIS_LINE_COLOR, width: 1, size: 4 },
    values: (u, splits) => {
      const decimals = timeDecimalsForScale(u);
      return splits.map((v) => formatTimeValue(v, decimals));
    },
  };
}

export function buildValueAxis(opts: { size: number }): uPlot.Axis {
  return {
    stroke: AXIS_LABEL_COLOR,
    font: AXIS_FONT,
    gap: 4,
    size: opts.size,
    grid: { stroke: GRID_COLOR, width: 1 },
    ticks: { show: false },
    values: (u, splits) => {
      const decimals = valueDecimalsForScale(u);
      return splits.map((v) => v.toFixed(decimals));
    },
  };
}

export function buildAreaFill(topColor: string, bottomColor: string): uPlot.Series.Fill {
  let cached: CanvasGradient | null = null;
  let cachedTop = -1;
  let cachedHeight = -1;

  return (u: uPlot) => {
    const { top, height } = u.bbox;
    if (cached === null || top !== cachedTop || height !== cachedHeight) {
      const gradient = u.ctx.createLinearGradient(0, top, 0, top + height);
      gradient.addColorStop(0, topColor);
      gradient.addColorStop(1, bottomColor);
      cached = gradient;
      cachedTop = top;
      cachedHeight = height;
    }
    return cached;
  };
}
