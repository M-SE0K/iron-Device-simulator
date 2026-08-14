import type uPlot from "uplot";

// 대시보드 공통 축/그리드 팔레트 — 모든 차트가 같은 값을 쓴다.
const AXIS_LABEL_COLOR = "#94A3B8";
const AXIS_LINE_COLOR = "#E2E8F0";
const GRID_COLOR = "#F1F5F9";
const AXIS_FONT = "10px system-ui, -apple-system, sans-serif";

/**
 * x축(시간)·y축(값)이 **공유하는 단일 자리수 규칙**. 눈금 라벨의 소수점 자리수를 지금
 * 보이는 폭(span)에 맞춰 늘린다 — 폭이 좁아질수록(=확대할수록) 눈금 간격도 좁아지므로,
 * 자리수가 고정이면 확대했을 때 인접 눈금이 같은 문자열이 돼 버린다(예: 0.000, 0.000…).
 *
 * `ceil(-log10(폭)) + 1`은 폭이 10이면 0자리, 1이면 1자리, 0.1이면 2자리… 식으로 "눈금
 * 간격보다 한 자리 더 세밀하게"를 뜻한다. x·y가 이 함수 하나를 함께 쓰므로 두 축의 줌
 * 반응이 항상 동일하다(채널 파형은 원본 샘플까지 확대되므로 상한을 6자리로 열어 둔다).
 */
const MAX_DECIMALS = 6;
const MIN_DECIMALS = 0;

export function decimalsForSpan(span: number): number {
  if (!isFinite(span) || span <= 0) return 3;
  const decimals = Math.ceil(-Math.log10(span)) + 1;
  return Math.min(MAX_DECIMALS, Math.max(MIN_DECIMALS, decimals));
}

/**
 * 시간 표시는 **모든 차트에서 초 단위 하나로 통일**한다(ms/µs로 갈아타지 않는다) —
 * 메트릭 차트·채널 파형·보호 감쇠 비교가 나란히 놓이는 화면에서 축마다 단위가 다르면
 * 값을 눈으로 비교할 수 없기 때문이다. 자리수만 위 공통 규칙으로 폭에 맞춰 늘린다.
 */
export function timeDecimalsForSpan(spanSec: number): number {
  return decimalsForSpan(spanSec);
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
  return decimalsForSpan((u.scales.x.max ?? 0) - (u.scales.x.min ?? 0));
}

/** 현재 y 스케일 폭에 맞는 소수점 자리수 — 값 축이 x축과 같은 규칙으로 줌에 반응하게 한다. */
export function valueDecimalsForScale(u: uPlot): number {
  return decimalsForSpan((u.scales.y.max ?? 0) - (u.scales.y.min ?? 0));
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

/**
 * 값(y)축 — 시간(x)축과 **동일한 규칙**으로 소수점 자리수를 현재 보이는 y 폭(줌 상태)에
 * 맞춰 늘린다. 차트별 고정 자리수(toFixed(2/3) 등)를 두지 않는 이유가 이것이다: y축을
 * 확대하면 uPlot이 더 촘촘한 눈금을 만드는데, 자리수가 고정이면 그 눈금들이 같은 문자열로
 * 뭉쳐 x축처럼 세밀해지지 않는다. `decimalsForSpan`을 x축과 공유하므로 두 축의 줌 반응이
 * 항상 같다.
 *
 * `unit`을 주면 각 라벨 뒤에 단위를 붙인다(예: "mm"). 생략하면 숫자만 — 단위를 값 헤더에
 * 따로 표시하는 차트는 축을 깔끔히 두려고 생략한다.
 */
export function buildValueAxis(opts: {
  size: number;
  unit?: string;
}): uPlot.Axis {
  const suffix = opts.unit ?? "";
  return {
    stroke: AXIS_LABEL_COLOR,
    font: AXIS_FONT,
    gap: 4,
    size: opts.size,
    grid: { stroke: GRID_COLOR, width: 1 },
    ticks: { show: false },
    values: (u, splits) => {
      const decimals = valueDecimalsForScale(u);
      return splits.map((v) => `${v.toFixed(decimals)}${suffix}`);
    },
  };
}

/**
 * 선 아래 면적 그라디언트 fill.
 *
 * uPlot은 리드로우마다 모든 시리즈에 대해 이 함수를 다시 부른다(drawSeries → cacheStrokeFill).
 * 그런데 그라디언트가 실제로 의존하는 건 플롯 영역의 **세로 위치와 높이**뿐이라, 줌·스트리밍
 * 으로 초당 수십 번 다시 그려도 결과는 리사이즈 전까지 같은 객체다 — 그 둘을 키로 캐시한다.
 */
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
