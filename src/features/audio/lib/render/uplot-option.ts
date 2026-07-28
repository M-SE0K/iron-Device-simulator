import type uPlot from "uplot";

// 대시보드 공통 축/그리드 팔레트 — 모든 차트가 같은 값을 쓴다.
export const AXIS_LABEL_COLOR = "#94A3B8";
export const AXIS_LINE_COLOR = "#E2E8F0";
export const GRID_COLOR = "#F1F5F9";
const AXIS_FONT = "10px system-ui, -apple-system, sans-serif";

const MAX_TIME_DECIMALS = 3;
const MIN_TIME_DECIMALS = 0;

export function timeDecimalsForInterval(intervalSec: number): number {
  if (!isFinite(intervalSec) || intervalSec <= 0) return MAX_TIME_DECIMALS;
  const decimals = Math.ceil(-Math.log10(intervalSec)) + 1;
  return Math.min(MAX_TIME_DECIMALS, Math.max(MIN_TIME_DECIMALS, decimals));
}

function decimalsForVisibleSpan(spanSec: number): number {
  if (!isFinite(spanSec) || spanSec <= 0) return MAX_TIME_DECIMALS;
  if (spanSec >= 10) return 0;
  if (spanSec >= 1) return 1;
  if (spanSec >= 0.1) return 2;
  return MAX_TIME_DECIMALS;
}

function floorFixed(v: number, decimals: number): string {
  const factor = 10 ** decimals;
  const floored = Math.floor(v * factor + 1e-9) / factor;
  return floored.toFixed(decimals);
}

/**
 * 시간(x)축 — 눈금 소수점을 현재 보이는 스팬(줌 상태)에 맞춰 동적으로 조절한다.
 */
export function buildTimeAxis(dataDecimals: number): uPlot.Axis {
  const effectiveMax = Math.min(dataDecimals, MAX_TIME_DECIMALS);
  return {
    stroke: AXIS_LABEL_COLOR,
    font: AXIS_FONT,
    gap: 4,
    size: 28,
    grid: { stroke: GRID_COLOR, width: 1 },
    ticks: { stroke: AXIS_LINE_COLOR, width: 1, size: 4 },
    values: (u, splits) => {
      const span = (u.scales.x.max ?? 0) - (u.scales.x.min ?? 0);
      const decimals = Math.min(effectiveMax, Math.max(MIN_TIME_DECIMALS, decimalsForVisibleSpan(span)));
      return splits.map((v) => `${floorFixed(v, decimals)}s`);
    },
  };
}

export function buildValueAxis(opts: {
  size: number;
  formatter?: (v: number) => string;
}): uPlot.Axis {
  return {
    stroke: AXIS_LABEL_COLOR,
    font: AXIS_FONT,
    gap: 4,
    size: opts.size,
    grid: { stroke: GRID_COLOR, width: 1 },
    ticks: { show: false },
    ...(opts.formatter
      ? { values: (_u: uPlot, splits: number[]) => splits.map(opts.formatter!) }
      : {}),
  };
}

/** 선 아래 면적 그라디언트 fill. */
export function buildAreaFill(topColor: string, bottomColor: string): uPlot.Series.Fill {
  return (u: uPlot) => {
    const gradient = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
    gradient.addColorStop(0, topColor);
    gradient.addColorStop(1, bottomColor);
    return gradient;
  };
}
