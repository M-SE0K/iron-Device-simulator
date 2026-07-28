/**
 * 차트 y축 표시 범위 계산.
 *
 * 예전엔 프레임 배열 전체를 훑어 극값을 구했지만, 지금은 ChartStore가 누적 극값을 push
 * 시점에 O(1)로 유지하므로 그 스칼라만 받는다 — 세션이 길어져도 범위 계산 비용이 늘지 않고,
 * 표시 점이 감량돼도 실제 피크 기준의 범위가 유지된다.
 */

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
