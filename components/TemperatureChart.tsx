"use client";

import dynamic from "next/dynamic";
import { useMemo, useLayoutEffect, useRef, useCallback } from "react";
import { Thermometer } from "lucide-react";
import { AnalysisFrame } from "@/lib/types";
import { findFrameIndex } from "@/lib/utils";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

interface Props {
  frames: AnalysisFrame[];
  currentTime: number;
  isActive: boolean;
  /** true: 스트리밍 append 모드 — 마지막 N 프레임 슬라이딩 윈도우 */
  streaming?: boolean;
  /** React 렌더 완료 시각 콜백 (useLayoutEffect) */
  onReactRender?: (ts: number) => void;
  /** ECharts 캔버스 드로우 완료 시각 콜백 */
  onEchartsRender?: (ts: number) => void;
}

const WARN_THRESHOLD   = 65;
const DANGER_THRESHOLD = 75;
const WINDOW_SIZE      = 1000; // 슬라이딩 윈도우 프레임 수

export default function TemperatureChart({ frames, currentTime, isActive, streaming = false, onReactRender, onEchartsRender }: Props) {
  // ── React 렌더 완료 시각 측정 ────────────────────────────────────────────
  // useLayoutEffect: React가 DOM을 커밋한 직후, 브라우저 페인트 전에 실행
  const prevFrameLenRef = useRef(0);
  useLayoutEffect(() => {
    if (streaming && frames.length !== prevFrameLenRef.current) {
      prevFrameLenRef.current = frames.length;
      onReactRender?.(performance.now());
    }
  });

  // ── ECharts rendered 이벤트 핸들러 ──────────────────────────────────────
  const echartsEvents = useRef<Record<string, () => void>>({});
  echartsEvents.current = {
    rendered: useCallback(() => {
      if (streaming && frames.length > 0) onEchartsRender?.(performance.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [streaming, frames.length, onEchartsRender]),
  };

  // ── 현재 값 & 윈도우 계산 ────────────────────────────────────────────────
  const { currentTemp, windowFrames } = useMemo(() => {
    if (!isActive || frames.length === 0) {
      return { currentTemp: null, windowFrames: frames.slice(0, WINDOW_SIZE) };
    }

    if (streaming) {
      // 스트리밍: 마지막 N 프레임 표시, 현재값 = 마지막 프레임
      const window    = frames.slice(-WINDOW_SIZE);
      const lastFrame = frames[frames.length - 1];
      return { currentTemp: lastFrame?.temperature ?? null, windowFrames: window };
    } else {
      // Pre-computed: binary search로 현재 재생 위치 프레임 조회
      const frameIdx  = findFrameIndex(frames.map((f) => f.time), currentTime);
      const temp      = frameIdx >= 0 ? frames[frameIdx]?.temperature ?? null : null;
      const start     = Math.max(0, frameIdx - (WINDOW_SIZE - 1));
      return { currentTemp: temp, windowFrames: frames.slice(start, frameIdx + 1) };
    }
  }, [frames, currentTime, isActive, streaming]);

  const tempColor =
    currentTemp === null
      ? "#7D8699"
      : currentTemp >= DANGER_THRESHOLD
      ? "#EF4444"
      : currentTemp >= WARN_THRESHOLD
      ? "#F59E0B"
      : "#0057B8";

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
        fillerColor: "rgba(0,87,184,0.12)",
        handleStyle: { color: "#0057B8", borderColor: "#0057B8" },
        moveHandleStyle: { color: "#0057B8" },
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
      name: "°C",
      nameTextStyle: { color: "#A4AABA", fontSize: 10 },
      axisLabel: { color: "#A4AABA", fontSize: 10 },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: "#F5F6F8" } },
      min: 30,
      max: 90,
    },
    series: [
      {
        type: "line",
        data: windowFrames.map((f) => [f.time, f.temperature]),
        smooth: true,
        symbol: "none",
        lineStyle: { color: "#0057B8", width: 2 },
        areaStyle: {
          color: {
            type: "linear",
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(0,87,184,0.18)" },
              { offset: 1, color: "rgba(0,87,184,0)" },
            ],
          },
        },
        markLine: {
          silent: true,
          symbol: "none",
          data: [
            {
              yAxis: WARN_THRESHOLD,
              lineStyle: { color: "#F59E0B", type: "dashed", width: 1 },
              label: { formatter: "WARN", color: "#F59E0B", fontSize: 9 },
            },
            {
              yAxis: DANGER_THRESHOLD,
              lineStyle: { color: "#EF4444", type: "dashed", width: 1 },
              label: { formatter: "DANGER", color: "#EF4444", fontSize: 9 },
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
        return `${t.toFixed(2)}s &nbsp; <b>${v.toFixed(1)} °C</b>`;
      },
    },
  }), [windowFrames]);

  return (
    <div id="temperature-chart" className="card flex flex-col h-full">
      <div className="card-header">
        <div className="chart-title-group flex items-center gap-2">
          <Thermometer size={14} className="text-iron-400" />
          <span className="card-title">Temperature</span>
        </div>
        {currentTemp !== null && (
          <span id="current-temperature-value" className="font-mono text-lg font-semibold" style={{ color: tempColor }}>
            {currentTemp.toFixed(1)}<span className="text-xs ml-0.5 font-normal">°C</span>
          </span>
        )}
      </div>

      <div className="chart-body flex-1 p-2 min-h-[180px]">
        {frames.length > 0 ? (
          <ReactECharts
            option={option}
            style={{ height: "100%", width: "100%" }}
            notMerge
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
