"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { Activity } from "lucide-react";
import { AnalysisFrame } from "@/lib/types";
import { findFrameIndex } from "@/lib/utils";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

interface Props {
  frames: AnalysisFrame[];
  currentTime: number;
  isActive: boolean;
  /** true: 스트리밍 append 모드 — 마지막 N 프레임 슬라이딩 윈도우 */
  streaming?: boolean;
}

const MAX_EXCURSION = 8;   // mm
const WINDOW_SIZE   = 1000;

export default function ExcursionChart({ frames, currentTime, isActive, streaming = false }: Props) {

  // ── 현재 값 & 윈도우 계산 ────────────────────────────────────────────────
  const { currentExc, windowFrames } = useMemo(() => {
    if (!isActive || frames.length === 0) {
      return { currentExc: null, windowFrames: frames.slice(0, WINDOW_SIZE) };
    }

    if (streaming) {
      // 스트리밍: 마지막 N 프레임 표시, 현재값 = 마지막 프레임
      const window    = frames.slice(-WINDOW_SIZE);
      const lastFrame = frames[frames.length - 1];
      return { currentExc: lastFrame?.excursion ?? null, windowFrames: window };
    } else {
      // Pre-computed: binary search로 현재 재생 위치 프레임 조회
      const frameIdx = findFrameIndex(frames.map((f) => f.time), currentTime);
      const exc      = frameIdx >= 0 ? frames[frameIdx]?.excursion ?? null : null;
      const start    = Math.max(0, frameIdx - (WINDOW_SIZE - 1));
      return { currentExc: exc, windowFrames: frames.slice(start, frameIdx + 1) };
    }
  }, [frames, currentTime, isActive, streaming]);

  const excColor = currentExc !== null && Math.abs(currentExc) > MAX_EXCURSION * 0.85
    ? "#EF4444"
    : "#10B981";

  const option = useMemo(() => ({
    animation: false,
    grid: { top: 8, right: 16, bottom: 52, left: 52 },
    dataZoom: [
      {
        type: "inside",
        xAxisIndex: 0,
        filterMode: "filter",
      },
      {
        type: "slider",
        xAxisIndex: 0,
        height: 16,
        bottom: 4,
        borderColor: "#E8EAF0",
        backgroundColor: "#F5F6F8",
        fillerColor: "rgba(16,185,129,0.12)",
        handleStyle: { color: "#10B981", borderColor: "#10B981" },
        moveHandleStyle: { color: "#10B981" },
        textStyle: { color: "#A4AABA", fontSize: 9 },
        labelFormatter: (v: number) => `${(v as number).toFixed(2)}s`,
      },
    ],
    xAxis: {
      type: "value",
      min: windowFrames[0]?.time ?? 0,
      max: windowFrames[windowFrames.length - 1]?.time ?? 10,
      axisLabel: { formatter: (v: number) => `${v.toFixed(2)}s`, color: "#A4AABA", fontSize: 10 },
      axisLine: { lineStyle: { color: "#E8EAF0" } },
      splitLine: { lineStyle: { color: "#F5F6F8" } },
    },
    yAxis: {
      type: "value",
      name: "mm",
      nameTextStyle: { color: "#A4AABA", fontSize: 10 },
      axisLabel: { color: "#A4AABA", fontSize: 10 },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: "#F5F6F8" } },
      min: -MAX_EXCURSION - 1,
      max: MAX_EXCURSION + 1,
    },
    series: [
      {
        type: "line",
        data: windowFrames.map((f) => [f.time, f.excursion]),
        smooth: 0.3,
        symbol: "none",
        lineStyle: { color: "#10B981", width: 1.5 },
        areaStyle: {
          color: {
            type: "linear",
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(16,185,129,0.15)" },
              { offset: 1, color: "rgba(16,185,129,0)" },
            ],
          },
        },
        markLine: {
          silent: true,
          symbol: "none",
          data: [
            {
              yAxis: MAX_EXCURSION,
              lineStyle: { color: "#EF4444", type: "dashed", width: 1 },
              label: { formatter: `+${MAX_EXCURSION}mm`, color: "#EF4444", fontSize: 9 },
            },
            {
              yAxis: -MAX_EXCURSION,
              lineStyle: { color: "#EF4444", type: "dashed", width: 1 },
              label: { formatter: `-${MAX_EXCURSION}mm`, color: "#EF4444", fontSize: 9 },
            },
          ],
        },
      },
    ],
    tooltip: {
      trigger: "axis",
      backgroundColor: "#1A1D23",
      borderColor: "#2E3440",
      textStyle: { color: "#E8EAF0", fontSize: 11, fontFamily: "JetBrains Mono" },
      formatter: (params: { data: [number, number] }[]) => {
        const [t, v] = params[0].data;
        return `${t.toFixed(2)}s &nbsp; <b>${v.toFixed(3)} mm</b>`;
      },
    },
  }), [windowFrames]);

  return (
    <div id="excursion-chart" className="card flex flex-col h-full">
      <div className="card-header">
        <div className="chart-title-group flex items-center gap-2">
          <Activity size={14} className="text-iron-400" />
          <span className="card-title">Excursion</span>
        </div>
        {currentExc !== null && (
          <span id="current-excursion-value" className="font-mono text-lg font-semibold" style={{ color: excColor }}>
            {currentExc.toFixed(2)}<span className="text-xs ml-0.5 font-normal">mm</span>
          </span>
        )}
      </div>

      <div className="chart-body flex-1 p-2 min-h-[180px]">
        {frames.length > 0 ? (
          <ReactECharts option={option} style={{ height: "100%", width: "100%" }} notMerge />
        ) : (
          <div className="chart-empty-state h-full flex items-center justify-center text-xs text-iron-300">
            재생하면 실시간으로 데이터가 표시됩니다
          </div>
        )}
      </div>
    </div>
  );
}
