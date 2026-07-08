// TemperatureChart/ExcursionChart이 동일하게 구현하던 ECharts 옵션 조각(dataZoom/시간축/
// 값 툴팁/범례)을 공유 빌더로 뽑아둔다. series·Y축(지표별로 알고리즘이 다름)·grid(좌측 여백만
// 다름)는 각 차트가 직접 구성한다.
import type { AnalysisFrame } from "@/features/audio/types";
import type { ChannelMode } from "./chart-window";

export interface ZoomState {
  start: number;
  end: number;
}

export function buildDataZoom(zoom: ZoomState, colors: { filler: string; handle: string }) {
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
      borderColor: "#E8EAF0",
      backgroundColor: "#F5F6F8",
      fillerColor: colors.filler,
      handleStyle: { color: colors.handle, borderColor: colors.handle },
      moveHandleStyle: { color: colors.handle },
      textStyle: { color: "#A4AABA", fontSize: 9 },
      labelFormatter: (v: number) => `${v.toFixed(2)}s`,
    },
  ];
}

export function buildTimeAxis(opts: {
  audioDuration?: number | null;
  followWindow?: boolean;
  windowFrames: AnalysisFrame[];
}) {
  const { audioDuration, followWindow, windowFrames } = opts;
  return {
    type: "value" as const,
    // batch(followWindow=false)+audioDuration: [0, 총길이] 고정
    // realtime(followWindow=true) 또는 마이크: 현재 윈도우 범위를 따라 스크롤
    min: (audioDuration != null && !followWindow) ? 0 : (windowFrames[0]?.time ?? 0),
    max: (audioDuration != null && !followWindow) ? audioDuration : (windowFrames[windowFrames.length - 1]?.time ?? 10),
    axisLabel: { formatter: (v: number) => `${v.toFixed(2)}s`, color: "#A4AABA", fontSize: 10 },
    axisLine: { lineStyle: { color: "#E8EAF0" } },
    splitLine: { lineStyle: { color: "#F5F6F8" } },
  };
}

export function buildValueTooltip(opts: { unit: string; decimals: number }) {
  const { unit, decimals } = opts;
  return {
    trigger: "axis" as const,
    backgroundColor: "#1A1D23",
    borderColor: "#2E3440",
    textStyle: { color: "#E8EAF0", fontSize: 11, fontFamily: "JetBrains Mono" },
    formatter: (params: { seriesName: string; data: [number, number] }[]) => {
      const t = params[0].data[0];
      const lines = params.map((p) => `${p.seriesName}: <b>${p.data[1].toFixed(decimals)} ${unit}</b>`);
      return `${t.toFixed(2)}s<br/>${lines.join("<br/>")}`;
    },
  };
}

export function buildLegend(channelMode: ChannelMode) {
  return channelMode === "Both"
    ? { top: "auto" as const, bottom: 56, textStyle: { color: "#A4AABA", fontSize: 10 } }
    : { show: false as const };
}
