"use client";

import dynamic from "next/dynamic";
import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import { Maximize2 } from "lucide-react";
import { AnalysisFrame } from "@/features/audio/types";
import { cn } from "@/shared/lib/utils";
import {
  computeStreamWindow, computeExcursionYRange, type ChannelMode,
} from "@/features/audio/lib/render/chart-window";
import { buildDataZoom, buildTimeAxis, buildValueTooltip, buildLegend } from "@/features/audio/lib/render/chart-option";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

interface Props {
  frames: AnalysisFrame[];
  currentTime: number;
  isActive: boolean;
  /** true: 스트리밍 append 모드 — 마지막 N 프레임 슬라이딩 윈도우 */
  streaming?: boolean;
  /** 오디오 총 길이(초) — 설정 시 X축을 [0, audioDuration]으로 고정 */
  audioDuration?: number | null;
  /** true(realtime): X축이 슬라이딩 윈도우를 따라감 / false(batch): [0, audioDuration] 고정 */
  followWindow?: boolean;
  /** LTTB 다운샘플링 on/off (측정 A/B용, 기본 on) */
  lttb?: boolean;
  /** 설정 시 헤더에 "자세히 보기" 확대 버튼을 렌더 → 클릭 시 상세 뷰 전환 */
  onExpand?: () => void;
}

const WINDOW_SIZE   = 1000;
const SCALE_PADDING = 1.15;
// 서버 raw 값 → UI 표기 단위([mm]) 변환 계수
const MM_SCALE      = 1 / 1000;
const toMm = (v: number) => v * MM_SCALE;

// 채널별 색상
const CH_COLOR: Record<ChannelMode, { ch0: string; ch1: string }> = {
  L:    { ch0: "#10B981", ch1: "#10B981" },
  R:    { ch0: "#F97316", ch1: "#F97316" },
  Both: { ch0: "#10B981", ch1: "#F97316" },
};

export default function ExcursionChart({ frames, currentTime, isActive, streaming = false, audioDuration, followWindow = false, lttb = true, onExpand }: Props) {
  const [channelMode, setChannelMode] = useState<ChannelMode>("Both");

  // ── 줌 상태 보존 ─────────────────────────────────────────────────────────
  const zoomRef = useRef({ start: 0, end: 100 });
  useEffect(() => { zoomRef.current = { start: 0, end: 100 }; }, [audioDuration]);

  const echartsEvents = useRef<Record<string, (...args: unknown[]) => void>>({});
  echartsEvents.current = {
    datazoom: useCallback((params: unknown) => {
      const p = params as { batch?: Array<{ start?: number; end?: number }>; start?: number; end?: number };
      const src = p.batch?.[0] ?? p;
      if (src.start !== undefined && src.end !== undefined) {
        zoomRef.current = { start: src.start, end: src.end };
      }
    }, []),
  };

  // ── 현재 값 & 윈도우 계산 ────────────────────────────────────────────────
  const { current: currentExc, windowFrames } = useMemo(
    () => computeStreamWindow(frames, currentTime, isActive, streaming, audioDuration, WINDOW_SIZE, (f) => f.excursion),
    [frames, currentTime, isActive, streaming],
  );

  // ── 창 내 데이터 범위로 Y축 동적 계산 ─────────────────────────────────────
  const { yMin, yMax } = useMemo(
    () => computeExcursionYRange(windowFrames, channelMode, toMm, SCALE_PADDING),
    [windowFrames, channelMode],
  );

  // ── 헤더 표시값 ──────────────────────────────────────────────────────────
  const displayExc = useMemo(() => {
    if (currentExc === null) return null;
    if (channelMode === "L") return currentExc[0];
    if (channelMode === "R") return currentExc[1];
    // Both: 절댓값이 더 큰 쪽
    return Math.abs(currentExc[0]) >= Math.abs(currentExc[1]) ? currentExc[0] : currentExc[1];
  }, [currentExc, channelMode]);

  const excColor =
    displayExc !== null && Math.abs(toMm(displayExc)) > Math.abs(yMax) * 0.85
      ? "#EF4444"
      : CH_COLOR[channelMode].ch0;

  // ── ECharts 옵션 ─────────────────────────────────────────────────────────
  const option = useMemo(() => {
    const colors = CH_COLOR[channelMode];

    // 다량 포인트 드로우 비용 상한: LTTB 다운샘플 + large 모드 (lttb=false면 미적용)
    const samplingOpts = lttb ? { sampling: "lttb" as const, large: true, largeThreshold: 2000 } : {};

    const seriesL = {
      name: "L (ch0)",
      type: "line" as const,
      data: windowFrames.map((f) => [f.time, toMm(f.excursion[0])]),
      smooth: 0.3,
      symbol: "none",
      ...samplingOpts,
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
      data: windowFrames.map((f) => [f.time, toMm(f.excursion[1])]),
      smooth: 0.3,
      symbol: "none",
      ...samplingOpts,
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
      legend: buildLegend(channelMode),
      dataZoom: buildDataZoom(zoomRef.current, { filler: "rgba(16,185,129,0.12)", handle: "#10B981" }),
      xAxis: buildTimeAxis({ audioDuration, followWindow, windowFrames }),
      yAxis: {
        type: "value",
        name: "mm",
        nameTextStyle: { color: "#A4AABA", fontSize: 10 },
        axisLabel: { color: "#A4AABA", fontSize: 10, formatter: (v: number) => v.toFixed(3) },
        axisLine: { show: false },
        splitLine: { lineStyle: { color: "#F5F6F8" } },
        min: yMin,
        max: yMax,
      },
      series,
      tooltip: buildValueTooltip({ unit: "mm", decimals: 3 }),
    };
  }, [windowFrames, channelMode, yMin, yMax, audioDuration, followWindow, lttb]);

  const showChart = audioDuration != null || frames.length > 0;

  return (
    <div id="excursion-chart" className="card flex flex-col h-full">
      <div className="card-header">
        <div className="chart-title-group flex items-center gap-2">
          <span className="card-title">Excursion</span>
          {onExpand && (
            <button
              type="button"
              onClick={onExpand}
              aria-label="익스커션 차트 자세히 보기"
              title="자세히 보기"
              className="ml-0.5 p-1 rounded text-iron-300 hover:text-emerald-600 hover:bg-emerald-50 transition-colors"
            >
              <Maximize2 size={13} />
            </button>
          )}
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
              <span style={{ color: CH_COLOR.Both.ch0 }}>{toMm(currentExc[0]).toFixed(3)}</span>
              <span className="text-iron-300 text-xs">/</span>
              <span style={{ color: CH_COLOR.Both.ch1 }}>{toMm(currentExc[1]).toFixed(3)}</span>
              <span className="text-xs ml-0.5 font-normal text-iron-400">mm</span>
            </div>
          ) : displayExc !== null ? (
            <span id="current-excursion-value" className="font-mono text-lg font-semibold" style={{ color: excColor }}>
              {toMm(displayExc).toFixed(3)}<span className="text-xs ml-0.5 font-normal text-iron-400">mm</span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="chart-body flex-1 p-2 min-h-[180px]">
        {showChart ? (
          <ReactECharts key={channelMode} option={option} style={{ height: "100%", width: "100%" }} notMerge={false} onEvents={echartsEvents.current} />
        ) : (
          <div className="chart-empty-state h-full flex items-center justify-center text-xs text-iron-300">
            재생하면 실시간으로 데이터가 표시됩니다
          </div>
        )}
      </div>
    </div>
  );
}
