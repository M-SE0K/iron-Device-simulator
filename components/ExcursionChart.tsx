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

const WINDOW_SIZE   = 1000;
// 익스커션 단위: 라이브러리 반환값이 raw count (mm 단위 미확인)
// 실측 범위 -256 ~ +255 → Y축 고정값 ±8mm로 설정하면 98% 데이터 누락
// → 창 내 실제 데이터 기준 동적 스케일링 사용
const SCALE_PADDING = 1.15; // 상하 15% 여유

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

  // ── 창 내 데이터 범위로 Y축 동적 계산 ─────────────────────────────────────
  const { yMin, yMax } = useMemo(() => {
    if (windowFrames.length === 0) return { yMin: -10, yMax: 10 };
    const vals = windowFrames.map((f) => f.excursion);
    const dataMin = Math.min(...vals);
    const dataMax = Math.max(...vals);
    const span    = Math.max(dataMax - dataMin, 1);
    const pad     = span * (SCALE_PADDING - 1);
    return {
      yMin: Math.floor(dataMin - pad),
      yMax: Math.ceil(dataMax  + pad),
    };
  }, [windowFrames]);

  const excColor = currentExc !== null && Math.abs(currentExc) > Math.abs(yMax) * 0.85
    ? "#EF4444"
    : "#10B981";

  const option = useMemo(() => ({
    animation: false,
    grid: { top: 8, right: 16, bottom: 52, left: 60 },
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
      // 단위 미확인 (raw int32 count) — 아이언디바이스 확인 후 변환 계수 적용 예정
      name: "raw",
      nameTextStyle: { color: "#A4AABA", fontSize: 10 },
      axisLabel: { color: "#A4AABA", fontSize: 10 },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: "#F5F6F8" } },
      min: yMin,
      max: yMax,
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
      },
    ],
    tooltip: {
      trigger: "axis",
      backgroundColor: "#1A1D23",
      borderColor: "#2E3440",
      textStyle: { color: "#E8EAF0", fontSize: 11, fontFamily: "JetBrains Mono" },
      formatter: (params: { data: [number, number] }[]) => {
        const [t, v] = params[0].data;
        return `${t.toFixed(2)}s &nbsp; <b>${v} raw</b>`;
      },
    },
  }), [windowFrames, yMin, yMax]);

  return (
    <div id="excursion-chart" className="card flex flex-col h-full">
      <div className="card-header">
        <div className="chart-title-group flex items-center gap-2">
          <Activity size={14} className="text-iron-400" />
          <span className="card-title">Excursion</span>
        </div>
        {currentExc !== null && (
          <span id="current-excursion-value" className="font-mono text-lg font-semibold" style={{ color: excColor }}>
            {currentExc}<span className="text-xs ml-0.5 font-normal text-iron-400">raw</span>
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
