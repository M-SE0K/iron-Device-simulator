import type uPlot from "uplot";

// 대시보드 공통 축/그리드 팔레트 — 모든 차트가 같은 값을 쓴다.
const AXIS_LABEL_COLOR = "#94A3B8";
const AXIS_LINE_COLOR = "#E2E8F0";
const GRID_COLOR = "#F1F5F9";
const AXIS_FONT = "10px system-ui, -apple-system, sans-serif";

/**
 * 시간 표시는 **모든 차트에서 초 단위 하나로 통일**한다(ms/µs로 갈아타지 않는다) —
 * 메트릭 차트·채널 파형·보호 감쇠 비교가 나란히 놓이는 화면에서 축마다 단위가 다르면
 * 값을 눈으로 비교할 수 없기 때문이다.
 *
 * 대신 소수점 자리수만 **지금 보이는 폭**에 맞춰 늘린다. 폭이 좁아질수록 눈금 간격도
 * 좁아지므로, 자리수가 고정이면 확대했을 때 모든 눈금이 같은 문자열이 돼 버린다.
 * 채널 파형은 원본 샘플까지 확대되므로(48 kHz에서 1샘플 = 20.83 µs) 상한을 6자리 =
 * 1 µs 해상도까지 열어 둔다.
 *
 * `ceil(-log10(폭)) + 1`은 폭이 10초면 0자리, 1초면 1자리, 0.1초면 2자리… 식으로
 * "눈금 간격보다 한 자리 더 세밀하게"를 뜻한다.
 */
const MAX_TIME_DECIMALS = 6;
const MIN_TIME_DECIMALS = 0;

function timeDecimalsForSpan(spanSec: number): number {
  if (!isFinite(spanSec) || spanSec <= 0) return 3;
  const decimals = Math.ceil(-Math.log10(spanSec)) + 1;
  return Math.min(MAX_TIME_DECIMALS, Math.max(MIN_TIME_DECIMALS, decimals));
}

/**
 * 시각 하나를 초 단위 라벨 문자열로 만든다.
 *
 * **반올림**이다. 예전엔 내림이었는데, 눈금값처럼 딱 떨어지는 수에는 차이가 없지만 커서
 * 위치처럼 임의의 값에는 마지막 자리 하나만큼 **항상 아래로** 치우친다 — 5.0s 눈금선 위에
 * 커서를 올려도 픽셀 환산값이 4.998이면 "4.9s"로 찍혀서 축과 툴팁이 어긋나 보였다.
 * 부동소수 오차(4.999999…)는 toFixed가 알아서 흡수하므로 별도 보정도 필요 없다.
 */
export function formatTimeValue(value: number, decimals: number): string {
  return `${value.toFixed(decimals)}s`;
}

/** 현재 x 스케일 폭에 맞는 소수점 자리수 — 축과 툴팁이 같은 값을 쓰게 하는 진입점. */
export function timeDecimalsForScale(u: uPlot): number {
  return timeDecimalsForSpan((u.scales.x.max ?? 0) - (u.scales.x.min ?? 0));
}

/**
 * 시간(x)축 — 단위는 항상 초, 소수점만 현재 보이는 폭(줌 상태)에 맞춰 늘린다.
 */
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
