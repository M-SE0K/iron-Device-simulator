// TemperatureChart/ExcursionChart이 각자 구현하던 "표시 윈도우 계산"·"Y축 동적 범위 계산"을 공유 순수 함수로 뽑아둔다. 두 차트의 실제 알고리즘(Y축 범위)은 지표별로 다르므로 하나로 합치지 않고, 각 차트가 자신에게 맞는 함수를 골라 쓴다.
import type { AnalysisFrame } from "@/features/audio/types";
import { findFrameIndex } from "@/shared/lib/utils";

export type ChannelMode = "L" | "R" | "Both";

export interface StreamWindowResult {
  /** 헤더에 표시할 현재값(스트리밍: 마지막 프레임 / 비스트리밍: currentTime 위치 프레임) */
  current: [number, number] | null;
  /** 차트에 그릴 윈도우 프레임 목록 */
  windowFrames: AnalysisFrame[];
}

/**
 * 실시간(streaming)/비실시간(seek) 공용 표시 윈도우 계산.
 *   - streaming + audioDuration 있음(파일 모드): 전체 누적 프레임
 *   - streaming + audioDuration 없음(마이크): 최근 windowSize 프레임만
 *   - 비streaming(seek): currentTime 위치까지 최대 windowSize 프레임 — 배치 분석 제거로
 *     현재 앱에서는 이 분기를 호출하는 곳이 없다(항상 streaming=true). 함수는 재사용
 *     가능성을 위해 남겨둔다.
 */
export function computeStreamWindow(
  frames: AnalysisFrame[],
  currentTime: number,
  isActive: boolean,
  streaming: boolean,
  audioDuration: number | null | undefined,
  windowSize: number,
  pick: (f: AnalysisFrame) => [number, number],
): StreamWindowResult {
  if (!isActive || frames.length === 0) {
    return { current: null, windowFrames: frames.slice(0, windowSize) };
  }

  if (streaming) {
    const windowFrames = audioDuration != null ? frames : frames.slice(-windowSize);
    const lastFrame = frames[frames.length - 1];
    return { current: lastFrame ? pick(lastFrame) : null, windowFrames };
  }

  const frameIdx = findFrameIndex(frames.map((f) => f.time), currentTime);
  const current   = frameIdx >= 0 && frames[frameIdx] ? pick(frames[frameIdx]) : null;
  const start     = Math.max(0, frameIdx - (windowSize - 1));
  return { current, windowFrames: frames.slice(start, frameIdx + 1) };
}

/**
 * 익스커션 Y축 동적 범위 — 표시 채널의 메인값 + envelope(min/max)까지 포함해 범위를 잡고
 * 대칭 패딩을 둔다(mm 등 표시 단위로 변환된 값 기준).
 */
export function computeExcursionYRange(
  windowFrames: AnalysisFrame[],
  channelMode: ChannelMode,
  toDisplayUnit: (v: number) => number,
  scalePadding: number,
): { yMin: number; yMax: number } {
  if (windowFrames.length === 0) return { yMin: -0.01, yMax: 0.01 };

  let rawMin = Infinity;
  let rawMax = -Infinity;
  const consider = (v: number) => { if (v < rawMin) rawMin = v; if (v > rawMax) rawMax = v; };
  for (const f of windowFrames) {
    if (channelMode !== "R") {
      consider(f.excursion[0]);
      if (f.excursionMin) consider(f.excursionMin[0]);
      if (f.excursionMax) consider(f.excursionMax[0]);
    }
    if (channelMode !== "L") {
      consider(f.excursion[1]);
      if (f.excursionMin) consider(f.excursionMin[1]);
      if (f.excursionMax) consider(f.excursionMax[1]);
    }
  }
  if (!isFinite(rawMin) || !isFinite(rawMax)) return { yMin: -0.01, yMax: 0.01 };

  const dataMin = toDisplayUnit(rawMin);
  const dataMax = toDisplayUnit(rawMax);
  const span    = Math.max(dataMax - dataMin, 0.001);
  const pad     = span * (scalePadding - 1);
  return { yMin: dataMin - pad, yMax: dataMax + pad };
}

/**
 * 온도 Y축 동적 범위 — 기본 0~100°C 고정, 표시 채널 값이 범위를 벗어나면 8% 헤드룸을 두고
 * '깔끔한' 단위(10/25/50/100)로 확장한다.
 */
export function computeTemperatureYRange(
  windowFrames: AnalysisFrame[],
  channelMode: ChannelMode,
): { yMin: number; yMax: number } {
  let dataMax = -Infinity;
  let dataMin = Infinity;
  for (const f of windowFrames) {
    if (channelMode !== "R") { const v = f.temperature[0]; if (v > dataMax) dataMax = v; if (v < dataMin) dataMin = v; }
    if (channelMode !== "L") { const v = f.temperature[1]; if (v > dataMax) dataMax = v; if (v < dataMin) dataMin = v; }
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
