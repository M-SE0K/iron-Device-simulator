"use client";

import dynamic from "next/dynamic";
import { useMemo, useLayoutEffect, useRef, useCallback, useState, useEffect } from "react";
import { Maximize2 } from "lucide-react";
import { AnalysisFrame } from "@/features/audio/types";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { DEFAULT_TEMP_WARN, DEFAULT_TEMP_DANGER } from "@/features/audio/lib/render/detect-events";
import {
  computeStreamWindow, computeTemperatureYRange, type ChannelMode,
} from "@/features/audio/lib/render/chart-window";
import { buildDataZoom, buildTimeAxis, buildValueTooltip, buildLegend, resolveTimeDecimals } from "@/features/audio/lib/render/chart-option";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

interface Props {
  frames: AnalysisFrame[];
  currentTime: number;
  isActive: boolean;
  /** true: 스트리밍 append 모드 — 마지막 N 프레임 슬라이딩 윈도우 */
  streaming?: boolean;
  /** 오디오 총 길이(초) — 표시용(헤더/showChart 판단), X축 범위 계산에는 쓰이지 않는다 */
  audioDuration?: number | null;
  /** LTTB 다운샘플링 on/off (측정 A/B용, 기본 on) */
  lttb?: boolean;
  /** React 렌더 완료 시각 콜백 (useLayoutEffect) */
  onReactRender?: (ts: number) => void;
  /** ECharts 캔버스 드로우 완료 시각 콜백 */
  onEchartsRender?: (ts: number) => void;
  /** 설정 시 헤더에 "자세히 보기" 확대 버튼을 렌더 → 클릭 시 상세 뷰 전환 */
  onExpand?: () => void;
  /** 온도 WARN 임계값(°C) — Calibration.tempWarn. 미지정 시 기본값(65°C) */
  warnThreshold?: number;
  /** 온도 DANGER 임계값(°C) — Calibration.tempDanger. 미지정 시 기본값(75°C) */
  dangerThreshold?: number;
}

const WINDOW_SIZE = 1000;

// 채널별 색상
const CH_COLOR: Record<ChannelMode, { ch0: string; ch1: string }> = {
  L:    { ch0: "#0B4171", ch1: "#0B4171" },
  R:    { ch0: "#6B9BD1", ch1: "#6B9BD1" },
  Both: { ch0: "#0B4171", ch1: "#6B9BD1" },
};

export default function TemperatureChart({ frames, currentTime, isActive, streaming = false, audioDuration, lttb = true, onReactRender, onEchartsRender, onExpand, warnThreshold = DEFAULT_TEMP_WARN, dangerThreshold = DEFAULT_TEMP_DANGER }: Props) {
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
  const { current: currentTemp, windowFrames } = useMemo(
    () => computeStreamWindow(frames, currentTime, isActive, streaming, audioDuration, WINDOW_SIZE, (f) => f.temperature),
    [frames, currentTime, isActive, streaming],
  );

  // ── 헤더 표시값 & 색상 ───────────────────────────────────────────────────
  const displayTemp = useMemo(() => {
    if (currentTemp === null) return null;
    if (channelMode === "L")    return currentTemp[0];
    if (channelMode === "R")    return currentTemp[1];
    return Math.max(currentTemp[0], currentTemp[1]); // Both: 더 높은 값 기준
  }, [currentTemp, channelMode]);

  const tempColor =
    displayTemp === null ? "#94A3B8"
    : displayTemp >= dangerThreshold ? "#EF4444"
    : displayTemp >= warnThreshold   ? "#F59E0B"
    : CH_COLOR[channelMode].ch0;

  // ── Y축 동적 범위 ────────────────────────────────────────────────────────
  const { yMin, yMax } = useMemo(
    () => computeTemperatureYRange(windowFrames, channelMode),
    [windowFrames, channelMode],
  );

  // ── ECharts 옵션 ─────────────────────────────────────────────────────────
  const option = useMemo(() => {
    const colors = CH_COLOR[channelMode];

    // 다량 포인트 드로우 비용 상한: LTTB 다운샘플 + large 모드 (lttb=false면 미적용)
    const samplingOpts = lttb ? { sampling: "lttb", large: true, largeThreshold: 2000 } : {};
    const timeDecimals = resolveTimeDecimals(windowFrames);

    const seriesL = {
      name: "L (ch0)",
      type: "line",
      data: windowFrames.map((f) => [f.time, f.temperature[0]]),
      smooth: true,
      symbol: "none",
      ...samplingOpts,
      lineStyle: { color: colors.ch0, width: 2 },
      areaStyle: channelMode !== "Both" ? {
        color: {
          type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: "rgba(11,65,113,0.18)" },
            { offset: 1, color: "rgba(11,65,113,0)" },
          ],
        },
      } : undefined,
      markLine: {
        silent: true,
        symbol: "none",
        data: [
          { yAxis: warnThreshold,   lineStyle: { color: "#F59E0B", type: "dashed", width: 1 }, label: { formatter: "WARN",   color: "#F59E0B", fontSize: 9 } },
          { yAxis: dangerThreshold, lineStyle: { color: "#EF4444", type: "dashed", width: 1 }, label: { formatter: "DANGER", color: "#EF4444", fontSize: 9 } },
        ],
      },
    };

    const seriesR = {
      name: "R (ch1)",
      type: "line",
      data: windowFrames.map((f) => [f.time, f.temperature[1]]),
      smooth: true,
      symbol: "none",
      ...samplingOpts,
      lineStyle: { color: colors.ch1, width: 2 },
      areaStyle: channelMode !== "Both" ? {
        color: {
          type: "linear",
          x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: "rgba(107,155,209,0.18)" },
            { offset: 1, color: "rgba(107,155,209,0)" },
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
      legend: buildLegend(channelMode),
      dataZoom: buildDataZoom(zoomRef, { filler: "rgba(11,65,113,0.12)", handle: "#0B4171" }, {
        dataMin: windowFrames[0]?.time ?? 0,
        dataMax: windowFrames[windowFrames.length - 1]?.time ?? 10,
        dataDecimals: timeDecimals,
      }),
      xAxis: buildTimeAxis({ windowFrames, zoomRef }),
      yAxis: {
        type: "value",
        name: "°C",
        nameTextStyle: { color: "#94A3B8", fontSize: 10 },
        axisLabel: { color: "#94A3B8", fontSize: 10 },
        axisLine: { show: false },
        splitLine: { lineStyle: { color: "#F1F5F9" } },
        min: yMin,
        max: yMax,
      },
      series,
      tooltip: buildValueTooltip({ unit: "°C", decimals: 1, timeDecimals }),
    };
  }, [windowFrames, channelMode, yMin, yMax, lttb, warnThreshold, dangerThreshold]);

  const showChart = audioDuration != null || frames.length > 0;

  return (
    <div id="temperature-chart" className="card flex flex-col h-full">
      <div className="card-header">
        <div className="chart-title-group flex items-center gap-2">
          <span className="card-title">Temperature</span>
          {onExpand && (
            <button
              type="button"
              onClick={onExpand}
              aria-label="온도 차트 자세히 보기"
              title="자세히 보기"
              className="ml-0.5 p-1 rounded text-iron-300 hover:text-brand-blue hover:bg-brand-blue/5 transition-colors"
            >
              <Maximize2 size={13} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* 채널 모드 토글 */}
          <SegmentedControl
            size="sm"
            value={channelMode}
            onChange={setChannelMode}
            options={[
              { value: "L", label: "L" },
              { value: "R", label: "R" },
              { value: "Both", label: "Both" },
            ]}
            className="w-[116px]"
            aria-label="온도 채널"
          />

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

      <div className="chart-body flex-1 p-2 min-h-[160px]">
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
