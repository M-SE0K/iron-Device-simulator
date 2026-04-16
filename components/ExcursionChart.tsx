"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { Activity } from "lucide-react";
import { AnalysisFrame } from "@/lib/types";
import { findFrameIndex } from "@/lib/utils";
import { cn } from "@/lib/utils";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

type ChannelMode = "L" | "R" | "Both";

interface Props {
  frames: AnalysisFrame[];
  currentTime: number;
  isActive: boolean;
  /** true: 스트리밍 append 모드 — 마지막 N 프레임 슬라이딩 윈도우 */
  streaming?: boolean;
}

const WINDOW_SIZE   = 1000;
const SCALE_PADDING = 1.15;

// 채널별 색상
const CH_COLOR: Record<ChannelMode, { ch0: string; ch1: string }> = {
  L:    { ch0: "#10B981", ch1: "#10B981" },
  R:    { ch0: "#F97316", ch1: "#F97316" },
  Both: { ch0: "#10B981", ch1: "#F97316" },
};

export default function ExcursionChart({ frames, currentTime, isActive, streaming = false }: Props) {
  const [channelMode, setChannelMode] = useState<ChannelMode>("Both");

  // ── 현재 값 & 윈도우 계산 ────────────────────────────────────────────────
  const { currentExc, windowFrames } = useMemo(() => {
    if (!isActive || frames.length === 0) {
      return { currentExc: null as [number, number] | null, windowFrames: frames.slice(0, WINDOW_SIZE) };
    }

    if (streaming) {
      const window    = frames.slice(-WINDOW_SIZE);
      const lastFrame = frames[frames.length - 1];
      return { currentExc: lastFrame?.excursion ?? null, windowFrames: window };
    } else {
      const frameIdx = findFrameIndex(frames.map((f) => f.time), currentTime);
      const exc      = frameIdx >= 0 ? frames[frameIdx]?.excursion ?? null : null;
      const start    = Math.max(0, frameIdx - (WINDOW_SIZE - 1));
      return { currentExc: exc, windowFrames: frames.slice(start, frameIdx + 1) };
    }
  }, [frames, currentTime, isActive, streaming]);

  // ── 창 내 데이터 범위로 Y축 동적 계산 ─────────────────────────────────────
  const { yMin, yMax } = useMemo(() => {
    if (windowFrames.length === 0) return { yMin: -10, yMax: 10 };

    // envelope (min/max)이 있으면 그 범위도 포함
    const valsL: number[] = [];
    const valsR: number[] = [];
    for (const f of windowFrames) {
      valsL.push(f.excursion[0]);
      valsR.push(f.excursion[1]);
      if (f.excursionMin) { valsL.push(f.excursionMin[0]); valsR.push(f.excursionMin[1]); }
      if (f.excursionMax) { valsL.push(f.excursionMax[0]); valsR.push(f.excursionMax[1]); }
    }

    const vals =
      channelMode === "L"    ? valsL :
      channelMode === "R"    ? valsR :
      /* Both */               [...valsL, ...valsR];

    const dataMin = Math.min(...vals);
    const dataMax = Math.max(...vals);
    const span    = Math.max(dataMax - dataMin, 1);
    const pad     = span * (SCALE_PADDING - 1);
    return {
      yMin: Math.floor(dataMin - pad),
      yMax: Math.ceil(dataMax  + pad),
    };
  }, [windowFrames, channelMode]);

  // ── 헤더 표시값 ──────────────────────────────────────────────────────────
  const displayExc = useMemo(() => {
    if (currentExc === null) return null;
    if (channelMode === "L") return currentExc[0];
    if (channelMode === "R") return currentExc[1];
    // Both: 절댓값이 더 큰 쪽
    return Math.abs(currentExc[0]) >= Math.abs(currentExc[1]) ? currentExc[0] : currentExc[1];
  }, [currentExc, channelMode]);

  const excColor =
    displayExc !== null && Math.abs(displayExc) > Math.abs(yMax) * 0.85
      ? "#EF4444"
      : CH_COLOR[channelMode].ch0;

  // ── ECharts 옵션 ─────────────────────────────────────────────────────────
  const option = useMemo(() => {
    const colors = CH_COLOR[channelMode];

    const seriesL = {
      name: "L (ch0)",
      type: "line" as const,
      data: windowFrames.map((f) => [f.time, f.excursion[0]]),
      smooth: 0.3,
      symbol: "none",
      lineStyle: { color: colors.ch0, width: 1.5 },
      areaStyle: channelMode !== "Both" ? {
        color: {
          type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: "rgba(16,185,129,0.15)" },
            { offset: 1, color: "rgba(16,185,129,0)" },
          ],
        },
      } : undefined,
    };

    const seriesR = {
      name: "R (ch1)",
      type: "line" as const,
      data: windowFrames.map((f) => [f.time, f.excursion[1]]),
      smooth: 0.3,
      symbol: "none",
      lineStyle: { color: colors.ch1, width: 1.5 },
      areaStyle: channelMode === "R" ? {
        color: {
          type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: "rgba(249,115,22,0.15)" },
            { offset: 1, color: "rgba(249,115,22,0)" },
          ],
        },
      } : undefined,
    };

    // Note: envelope 데이터(excursionMin/Max)는 AnalysisFrame에 보존되어 있으나,
    // 차트에 추가 series로 렌더링하면 ECharts 부하가 3배 증가하여 latency에 영향을 준다.
    // envelope 시각화는 비실시간 분석 뷰에서만 사용하고, 실시간 차트는 메인 선만 표시한다.

    const series =
      channelMode === "L"    ? [seriesL] :
      channelMode === "R"    ? [seriesR] :
      /* Both */               [seriesL, seriesR];

    return {
      animation: false,
      grid: { top: 8, right: 16, bottom: 52, left: 60 },
      legend: channelMode === "Both"
        ? { top: "auto", bottom: 56, textStyle: { color: "#A4AABA", fontSize: 10 } }
        : { show: false },
      dataZoom: [
        { type: "inside", xAxisIndex: 0, filterMode: "filter" },
        {
          type: "slider", xAxisIndex: 0, height: 16, bottom: 4,
          borderColor: "#E8EAF0", backgroundColor: "#F5F6F8",
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
        name: "raw",
        nameTextStyle: { color: "#A4AABA", fontSize: 10 },
        axisLabel: { color: "#A4AABA", fontSize: 10 },
        axisLine: { show: false },
        splitLine: { lineStyle: { color: "#F5F6F8" } },
        min: yMin,
        max: yMax,
      },
      series,
      tooltip: {
        trigger: "axis",
        backgroundColor: "#1A1D23",
        borderColor: "#2E3440",
        textStyle: { color: "#E8EAF0", fontSize: 11, fontFamily: "JetBrains Mono" },
        formatter: (params: { seriesName: string; data: [number, number] }[]) => {
          const t = params[0].data[0];
          const lines = params.map((p) => `${p.seriesName}: <b>${p.data[1]} raw</b>`);
          return `${t.toFixed(2)}s<br/>${lines.join("<br/>")}`;
        },
      },
    };
  }, [windowFrames, channelMode, yMin, yMax]);

  return (
    <div id="excursion-chart" className="card flex flex-col h-full">
      <div className="card-header">
        <div className="chart-title-group flex items-center gap-2">
          <Activity size={14} className="text-iron-400" />
          <span className="card-title">Excursion</span>
        </div>

        <div className="flex items-center gap-2">
          {/* 채널 모드 토글 */}
          <div className="flex gap-0.5 text-xs font-mono">
            {(["L", "R", "Both"] as ChannelMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setChannelMode(m)}
                className={cn(
                  "px-1.5 py-0.5 rounded border transition-all",
                  channelMode === m
                    ? "bg-emerald-600 text-white border-emerald-600"
                    : "text-iron-400 border-iron-200 hover:border-iron-400"
                )}
              >
                {m}
              </button>
            ))}
          </div>

          {/* 현재값 표시 */}
          {currentExc !== null && channelMode === "Both" ? (
            <div className="flex items-center gap-1.5 font-mono text-sm font-semibold">
              <span style={{ color: CH_COLOR.Both.ch0 }}>{currentExc[0]}</span>
              <span className="text-iron-300 text-xs">/</span>
              <span style={{ color: CH_COLOR.Both.ch1 }}>{currentExc[1]}</span>
            </div>
          ) : displayExc !== null ? (
            <span id="current-excursion-value" className="font-mono text-lg font-semibold" style={{ color: excColor }}>
              {displayExc}<span className="text-xs ml-0.5 font-normal text-iron-400">raw</span>
            </span>
          ) : null}
        </div>
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
