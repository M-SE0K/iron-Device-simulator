"use client";

import dynamic from "next/dynamic";
import { useMemo, useLayoutEffect, useRef, useCallback, useState, useEffect } from "react";
import { Thermometer } from "lucide-react";
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
  /** 오디오 총 길이(초) — 설정 시 X축을 [0, audioDuration]으로 고정 */
  audioDuration?: number | null;
  /** React 렌더 완료 시각 콜백 (useLayoutEffect) */
  onReactRender?: (ts: number) => void;
  /** ECharts 캔버스 드로우 완료 시각 콜백 */
  onEchartsRender?: (ts: number) => void;
}

const WARN_THRESHOLD   = 65;
const DANGER_THRESHOLD = 75;
const WINDOW_SIZE      = 1000;

// 채널별 색상
const CH_COLOR: Record<ChannelMode, { ch0: string; ch1: string }> = {
  L:    { ch0: "#0057B8", ch1: "#0057B8" },
  R:    { ch0: "#7C3AED", ch1: "#7C3AED" },
  Both: { ch0: "#0057B8", ch1: "#7C3AED" },
};

export default function TemperatureChart({ frames, currentTime, isActive, streaming = false, audioDuration, onReactRender, onEchartsRender }: Props) {
  const [channelMode, setChannelMode] = useState<ChannelMode>("Both");

  // ── 줌 상태 보존 — ref로 관리해서 렌더 유발 없이 option에 반영 ────────────
  const zoomRef = useRef({ start: 0, end: 100 });
  // 새 파일 로드(audioDuration 변경) 시 줌 초기화
  useEffect(() => { zoomRef.current = { start: 0, end: 100 }; }, [audioDuration]);

  // ── React 렌더 완료 시각 측정 ────────────────────────────────────────────
  const prevFrameLenRef = useRef(0);
  useLayoutEffect(() => {
    if (streaming && frames.length !== prevFrameLenRef.current) {
      prevFrameLenRef.current = frames.length;
      onReactRender?.(performance.now());
    }
  });

  // ── ECharts 이벤트 핸들러 ────────────────────────────────────────────────
  const echartsEvents = useRef<Record<string, (...args: unknown[]) => void>>({});
  echartsEvents.current = {
    rendered: useCallback(() => {
      if (streaming && frames.length > 0) onEchartsRender?.(performance.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [streaming, frames.length, onEchartsRender]),
    // datazoom 이벤트에서 현재 줌 상태를 ref에 저장
    datazoom: useCallback((params: unknown) => {
      const p = params as { batch?: Array<{ start?: number; end?: number }>; start?: number; end?: number };
      const src = p.batch?.[0] ?? p;
      if (src.start !== undefined && src.end !== undefined) {
        zoomRef.current = { start: src.start, end: src.end };
      }
    }, []),
  };

  // ── 현재 값 & 윈도우 계산 ────────────────────────────────────────────────
  const { currentTemp, windowFrames } = useMemo(() => {
    if (!isActive || frames.length === 0) {
      return { currentTemp: null as [number, number] | null, windowFrames: frames.slice(0, WINDOW_SIZE) };
    }

    if (streaming) {
      // audioDuration이 설정된 경우(파일 모드): 전체 누적 프레임을 그대로 사용
      // 설정되지 않은 경우(마이크 모드): 최근 WINDOW_SIZE 프레임만 유지
      const windowFrames = audioDuration != null ? frames : frames.slice(-WINDOW_SIZE);
      const lastFrame    = frames[frames.length - 1];
      return { currentTemp: lastFrame?.temperature ?? null, windowFrames };
    } else {
      const frameIdx = findFrameIndex(frames.map((f) => f.time), currentTime);
      const temp     = frameIdx >= 0 ? frames[frameIdx]?.temperature ?? null : null;
      const start    = Math.max(0, frameIdx - (WINDOW_SIZE - 1));
      return { currentTemp: temp, windowFrames: frames.slice(start, frameIdx + 1) };
    }
  }, [frames, currentTime, isActive, streaming]);

  // ── 헤더 표시값 & 색상 ───────────────────────────────────────────────────
  const displayTemp = useMemo(() => {
    if (currentTemp === null) return null;
    if (channelMode === "L")    return currentTemp[0];
    if (channelMode === "R")    return currentTemp[1];
    return Math.max(currentTemp[0], currentTemp[1]); // Both: 더 높은 값 기준
  }, [currentTemp, channelMode]);

  const tempColor =
    displayTemp === null ? "#7D8699"
    : displayTemp >= DANGER_THRESHOLD ? "#EF4444"
    : displayTemp >= WARN_THRESHOLD   ? "#F59E0B"
    : CH_COLOR[channelMode].ch0;

  // ── ECharts 옵션 ─────────────────────────────────────────────────────────
  const option = useMemo(() => {
    const colors = CH_COLOR[channelMode];
    const { start, end } = zoomRef.current; // 현재 줌 상태 (ref → 렌더 유발 없음)

    const seriesL = {
      name: "L (ch0)",
      type: "line",
      data: windowFrames.map((f) => [f.time, f.temperature[0]]),
      smooth: true,
      symbol: "none",
      lineStyle: { color: colors.ch0, width: 2 },
      areaStyle: channelMode !== "Both" ? {
        color: {
          type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: "rgba(0,87,184,0.18)" },
            { offset: 1, color: "rgba(0,87,184,0)" },
          ],
        },
      } : undefined,
      markLine: {
        silent: true,
        symbol: "none",
        data: [
          { yAxis: WARN_THRESHOLD,   lineStyle: { color: "#F59E0B", type: "dashed", width: 1 }, label: { formatter: "WARN",   color: "#F59E0B", fontSize: 9 } },
          { yAxis: DANGER_THRESHOLD, lineStyle: { color: "#EF4444", type: "dashed", width: 1 }, label: { formatter: "DANGER", color: "#EF4444", fontSize: 9 } },
        ],
      },
    };

    const seriesR = {
      name: "R (ch1)",
      type: "line",
      data: windowFrames.map((f) => [f.time, f.temperature[1]]),
      smooth: true,
      symbol: "none",
      lineStyle: { color: colors.ch1, width: 2 },
      areaStyle: channelMode !== "Both" ? {
        color: {
          type: "linear",
          x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: "rgba(124,58,237,0.18)" },
            { offset: 1, color: "rgba(124,58,237,0)" },
          ],
        },
      } : undefined,
    };

    const series =
      channelMode === "L"    ? [seriesL] :
      channelMode === "R"    ? [{ ...seriesR, markLine: seriesL.markLine }] :
      /* Both */               [seriesL, seriesR];

    return {
      animation: false,
      grid: { top: 8, right: 16, bottom: 52, left: 52 },
      legend: channelMode === "Both"
        ? { top: "auto", bottom: 56, textStyle: { color: "#A4AABA", fontSize: 10 } }
        : { show: false },
      dataZoom: [
        {
          type: "inside",
          xAxisIndex: 0,
          filterMode: "filter",
          start, end,             // 저장된 줌 상태 유지
          zoomOnMouseWheel: true,
          moveOnMouseMove: true,
          moveOnMouseWheel: false,
        },
        {
          type: "slider", xAxisIndex: 0, height: 16, bottom: 4,
          start, end,             // 슬라이더도 동기화
          borderColor: "#E8EAF0", backgroundColor: "#F5F6F8",
          fillerColor: "rgba(0,87,184,0.12)",
          handleStyle: { color: "#0057B8", borderColor: "#0057B8" },
          moveHandleStyle: { color: "#0057B8" },
          textStyle: { color: "#A4AABA", fontSize: 9 },
          labelFormatter: (v: number) => `${(v as number).toFixed(2)}s`,
        },
      ],
      xAxis: {
        type: "value",
        // audioDuration이 있으면 [0, 총길이]로 고정 — 없으면 데이터 범위에 따라 동적
        min: audioDuration != null ? 0 : (windowFrames[0]?.time ?? 0),
        max: audioDuration != null ? audioDuration : (windowFrames[windowFrames.length - 1]?.time ?? 10),
        axisLabel: { formatter: (v: number) => `${v.toFixed(2)}s`, color: "#A4AABA", fontSize: 10 },
        axisLine: { lineStyle: { color: "#E8EAF0" } },
        splitLine: { lineStyle: { color: "#F5F6F8" } },
      },
      yAxis: {
        type: "value",
        name: "°C",
        nameTextStyle: { color: "#A4AABA", fontSize: 10 },
        axisLabel: { color: "#A4AABA", fontSize: 10 },
        axisLine: { show: false },
        splitLine: { lineStyle: { color: "#F5F6F8" } },
        min: 0,
        max: 100,
      },
      series,
      tooltip: {
        trigger: "axis",
        backgroundColor: "#1A1D23",
        borderColor: "#2E3440",
        textStyle: { color: "#E8EAF0", fontSize: 11, fontFamily: "JetBrains Mono" },
        formatter: (params: { seriesName: string; data: [number, number] }[]) => {
          const t = params[0].data[0];
          const lines = params.map((p) => `${p.seriesName}: <b>${p.data[1].toFixed(1)} °C</b>`);
          return `${t.toFixed(2)}s<br/>${lines.join("<br/>")}`;
        },
      },
    };
  }, [windowFrames, channelMode, audioDuration]);

  const showChart = audioDuration != null || frames.length > 0;

  return (
    <div id="temperature-chart" className="card flex flex-col h-full">
      <div className="card-header">
        <div className="chart-title-group flex items-center gap-2">
          <Thermometer size={14} className="text-iron-400" />
          <span className="card-title">Temperature</span>
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
                    ? "bg-brand-blue text-white border-brand-blue"
                    : "text-iron-400 border-iron-200 hover:border-iron-400"
                )}
              >
                {m}
              </button>
            ))}
          </div>

          {/* 현재값 표시 */}
          {currentTemp !== null && channelMode === "Both" ? (
            <div className="flex items-center gap-1.5 font-mono text-sm font-semibold">
              <span style={{ color: CH_COLOR.Both.ch0 }}>{currentTemp[0].toFixed(1)}°</span>
              <span className="text-iron-300 text-xs">/</span>
              <span style={{ color: CH_COLOR.Both.ch1 }}>{currentTemp[1].toFixed(1)}°</span>
            </div>
          ) : displayTemp !== null ? (
            <span id="current-temperature-value" className="font-mono text-lg font-semibold" style={{ color: tempColor }}>
              {displayTemp.toFixed(1)}<span className="text-xs ml-0.5 font-normal">°C</span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="chart-body flex-1 p-2 min-h-[180px]">
        {showChart ? (
          <ReactECharts
            key={channelMode}
            option={option}
            style={{ height: "100%", width: "100%" }}
            notMerge={false}
            onEvents={echartsEvents.current}
          />
        ) : (
          <div className="chart-empty-state h-full flex items-center justify-center text-xs text-iron-300">
            재생하면 실시간으로 데이터가 표시됩니다
          </div>
        )}
      </div>
    </div>
  );
}
