// TemperatureChart/ExcursionChart이 동일하게 구현하던 ECharts 옵션 조각(dataZoom/시간축/값 툴팁/범례)을 공유 빌더로 뽑아둔다. series·Y축(지표별로 알고리즘이 다름)·grid(좌측 여백만 다름)는 각 차트가 직접 구성한다.

import type { AnalysisFrame } from "@/features/audio/types";
import type { ChannelMode } from "./chart-window";

export interface ZoomState {
  start: number;
  end: number;
}

// 줌 상태를 라이브로 읽기 위한 ref 형태 — 각 차트가 이미 datazoom 이벤트에서 갱신하는
// zoomRef를 그대로 넘기면, 여기서 만든 formatter들이 React 리렌더 없이도(ECharts가 줌/팬마다
// 스스로 axisLabel.formatter를 다시 호출하므로) 항상 최신 줌 위치를 반영해 자릿수를 조정한다.
export type ZoomStateRef = { current: ZoomState };

// 표시 소수 자릿수 상한 — 1/1000s(ms) 수준이면 충분하다는 판단.
const MAX_TIME_DECIMALS = 3;
const MIN_TIME_DECIMALS = 0;

// 두 데이터 포인트 사이의 최소 시간 간격을 서로 구분할 수 있는 최소 소수 자릿수를 계산한다.
// 예: 480 samples/48kHz(기본 분석 프레임) = 10ms 간격 → 3자리(ms)로 충분히 구분됨.
export function timeDecimalsForInterval(intervalSec: number): number {
  if (!isFinite(intervalSec) || intervalSec <= 0) return MAX_TIME_DECIMALS;
  // 간격의 두 번째 유효자리까지 구분되도록 +1
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

// 현재 화면에 보이는 구간 폭(초)에 맞춰 필요한 소수 자릿수를 고른다 — 넓게 보면(수십 초 단위)
// 자릿수를 줄여 깔끔하게, 좁게 확대할수록(수백 ms 이하) 자릿수를 늘려 시인성을 높인다.
function decimalsForVisibleSpan(spanSec: number): number {
  if (!isFinite(spanSec) || spanSec <= 0) return MAX_TIME_DECIMALS;
  if (spanSec >= 10) return 0;
  if (spanSec >= 1) return 1;
  if (spanSec >= 0.1) return 2;
  return MAX_TIME_DECIMALS;
}

// 줌 상태(zoom.start~end, %) 기준으로 동적 소수 자릿수를 계산한다. 데이터 해상도(dataDecimals)와
// 표시 상한(MAX_TIME_DECIMALS)을 넘지는 않는다.
function resolveDynamicDecimals(dataMin: number, dataMax: number, dataDecimals: number, zoom: ZoomState): number {
  const totalSpan = dataMax - dataMin;
  const visibleSpan = totalSpan * Math.max(0, zoom.end - zoom.start) / 100;
  const spanDecimals = decimalsForVisibleSpan(visibleSpan);
  const effectiveMax = Math.min(dataDecimals, MAX_TIME_DECIMALS);
  return Math.min(effectiveMax, Math.max(MIN_TIME_DECIMALS, spanDecimals));
}

// buildTimeAxis와 buildDataZoom(슬라이더 라벨), 그리고 프레임이 아닌 원본 샘플 기반 축을 쓰는
// ChannelWaveformCanvas가 공유하는 동적 소수 자릿수 포매터.
export function buildDynamicTimeFormatter(
  zoomRef: ZoomStateRef,
  domain: { dataMin: number; dataMax: number; dataDecimals: number },
) {
  const { dataMin, dataMax, dataDecimals } = domain;
  return (v: number) => `${v.toFixed(resolveDynamicDecimals(dataMin, dataMax, dataDecimals, zoomRef.current))}s`;
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

export function buildTimeAxis(opts: {
  windowFrames: AnalysisFrame[];
  zoomRef: ZoomStateRef;
}) {
  const { windowFrames, zoomRef } = opts;
  const dataMin = windowFrames[0]?.time ?? 0;
  const dataMax = windowFrames[windowFrames.length - 1]?.time ?? 10;
  const dataDecimals = resolveTimeDecimals(windowFrames);
  return {
    type: "value" as const,
    // 항상 현재 윈도우 범위를 따라 스크롤한다(파일 재생/마이크 캡처 공통 — 분석은 항상
    // 캡처 파이프라인의 실시간 스트림이라 "전체 곡선 고정 축"은 없다).
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

export function buildLegend(channelMode: ChannelMode) {
  return channelMode === "Both"
    ? { top: "auto" as const, bottom: 56, textStyle: { color: "#94A3B8", fontSize: 10 } }
    : { show: false as const };
}
