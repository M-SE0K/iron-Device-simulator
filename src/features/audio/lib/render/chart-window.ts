import type { AnalysisFrame } from "@/features/audio/types";

export interface StreamWindowResult {
  current: number | null;
  windowFrames: AnalysisFrame[];
}

/**
 * 차트가 그릴 프레임 창 + 현재값. 대시보드/상세 뷰 모두 라이브 캡처 스트림만 그리므로
 * 창은 언제나 누적된 프레임 전체이고, 현재값은 마지막 프레임이다.
 *
 * 예전엔 여기에 "재생 위치(currentTime) 기준으로 과거 N개만 잘라 보는" 비스트리밍 분기가
 * 같이 있었지만, 파일 재생이 하드웨어 캡처 스트림을 그대로 그리게 되면서 그 경로로
 * 들어오는 호출자가 없어졌다 — frames 참조를 그대로 돌려주므로 매 렌더 새 배열을 만들지
 * 않는다(차트의 data useMemo가 프레임이 실제로 늘었을 때만 다시 계산된다).
 */
export function computeStreamWindow(
  frames: AnalysisFrame[],
  isActive: boolean,
  pick: (f: AnalysisFrame) => number,
): StreamWindowResult {
  if (!isActive || frames.length === 0) return { current: null, windowFrames: frames };

  const lastFrame = frames[frames.length - 1];
  return { current: lastFrame ? pick(lastFrame) : null, windowFrames: frames };
}

export function computeExcursionYRange(
  windowFrames: AnalysisFrame[],
  toDisplayUnit: (v: number) => number,
  scalePadding: number,
): { yMin: number; yMax: number } {
  if (windowFrames.length === 0) return { yMin: -0.01, yMax: 0.01 };

  let rawMin = Infinity;
  let rawMax = -Infinity;
  const consider = (v: number) => { if (v < rawMin) rawMin = v; if (v > rawMax) rawMax = v; };
  for (const f of windowFrames) {
    consider(f.excursion);
    if (f.excursionMin !== undefined) consider(f.excursionMin);
    if (f.excursionMax !== undefined) consider(f.excursionMax);
  }
  if (!isFinite(rawMin) || !isFinite(rawMax)) return { yMin: -0.01, yMax: 0.01 };

  const dataMin = toDisplayUnit(rawMin);
  const dataMax = toDisplayUnit(rawMax);
  const span    = Math.max(dataMax - dataMin, 0.001);
  const pad     = span * (scalePadding - 1);
  return { yMin: dataMin - pad, yMax: dataMax + pad };
}

export function computeTemperatureYRange(
  windowFrames: AnalysisFrame[],
): { yMin: number; yMax: number } {
  let dataMax = -Infinity;
  let dataMin = Infinity;
  for (const f of windowFrames) {
    const v = f.temperature;
    if (v > dataMax) dataMax = v;
    if (v < dataMin) dataMin = v;
  }

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
