/**
 * 차트 y축 표시 범위 계산.
 *
 * 예전엔 프레임 배열 전체를 훑어 극값을 구했지만, 지금은 ChartStore가 누적 극값을 push
 * 시점에 O(1)로 유지하므로 그 스칼라만 받는다 — 세션이 길어져도 범위 계산 비용이 늘지 않고,
 * 표시 점이 감량돼도 실제 피크 기준의 범위가 유지된다.
 */

/** 파형 y축이 피크 위로 확보하는 여유 비율 — 선이 카드 위아래에 딱 붙지 않게 한다. */
const Y_SCALE_PADDING = 1.1;

/**
 * 파형 차트의 대칭 y 범위 [-yMax, yMax]. `minSpan`은 무음/초기 상태에서 폭이 0으로
 * 붕괴하지 않게 하는 최소 반높이다 — 하한을 이미 피크에 반영해 넘기는 호출부는 0을 준다.
 */
export function symmetricYRange(peak: number, minSpan: number): [number, number] {
  const yMax = Math.max(peak * Y_SCALE_PADDING, minSpan);
  return [-yMax, yMax];
}

export function computeExcursionYRange(
  rawMin: number,
  rawMax: number,
  toDisplayUnit: (v: number) => number,
  scalePadding: number,
): { yMin: number; yMax: number } {
  if (!isFinite(rawMin) || !isFinite(rawMax)) return { yMin: -0.01, yMax: 0.01 };

  const dataMin = toDisplayUnit(rawMin);
  const dataMax = toDisplayUnit(rawMax);
  const span    = Math.max(dataMax - dataMin, 0.001);
  const pad     = span * (scalePadding - 1);
  return { yMin: dataMin - pad, yMax: dataMax + pad };
}

export function computeTemperatureYRange(
  dataMin: number,
  dataMax: number,
): { yMin: number; yMax: number } {
  const niceStep = (v: number) => (v <= 200 ? 10 : v <= 500 ? 25 : v <= 1000 ? 50 : 100);

  let yMax = 100;
  if (isFinite(dataMax) && dataMax > 100) {
    const withHeadroom = dataMax * 1.08;
    const step = niceStep(withHeadroom);
    yMax = Math.ceil(withHeadroom / step) * step;
  }

  let yMin = 0;
  if (isFinite(dataMin) && dataMin < 0) {
    const withHeadroom = dataMin * 1.08;
    const step = niceStep(Math.abs(withHeadroom));
    yMin = Math.floor(withHeadroom / step) * step;
  }

  return { yMin, yMax };
}
