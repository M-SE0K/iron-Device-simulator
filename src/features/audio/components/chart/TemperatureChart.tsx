"use client";

import { useMemo, useLayoutEffect, useRef, useCallback, useState, useEffect } from "react";
import { Maximize2 } from "lucide-react";
import { AnalysisFrame } from "@/features/audio/types";
import ReactECharts from "@/shared/components/ReactECharts";
import SegmentedControl from "@/shared/components/ui/SegmentedControl";
import { perf } from "@/features/audio/lib/perf/collector";
import { e2e } from "@/features/audio/lib/perf-e2e/collector";
import { DEFAULT_TEMP_WARN, DEFAULT_TEMP_DANGER } from "@/features/audio/lib/render/detect-events";
import {
  computeStreamWindow, computeTemperatureYRange, WINDOW_SIZE, type ChannelMode,
} from "@/features/audio/lib/render/chart-window";
import {
  buildValueTooltip, resolveTimeDecimals,
  buildAreaGradient, buildValueYAxis, buildLineSeries, buildBaseChartOption,
  shouldShowFrameSymbols,
} from "@/features/audio/lib/render/chart-option";

interface Props {
  frames: AnalysisFrame[];
  currentTime: number;
  isActive: boolean;
  streaming?: boolean;
  audioDuration?: number | null;
  lttb?: boolean;
  perfTrack?: boolean;
  onExpand?: () => void;
  warnThreshold?: number;
  dangerThreshold?: number;
}

const CH_COLOR: Record<ChannelMode, { ch0: string; ch1: string }> = {
  L:    { ch0: "#0B4171", ch1: "#0B4171" },
  R:    { ch0: "#6B9BD1", ch1: "#6B9BD1" },
  Both: { ch0: "#0B4171", ch1: "#6B9BD1" },
};

export default function TemperatureChart({ frames, currentTime, isActive, streaming = false, audioDuration, lttb = true, perfTrack = false, onExpand, warnThreshold = DEFAULT_TEMP_WARN, dangerThreshold = DEFAULT_TEMP_DANGER }: Props) {
  const [channelMode, setChannelMode] = useState<ChannelMode>("Both");

  const zoomRef = useRef({ start: 0, end: 100 });
  const [showSymbols, setShowSymbols] = useState(false);
  const pointCountRef = useRef(0);
  useEffect(() => { zoomRef.current = { start: 0, end: 100 }; setShowSymbols(false); }, [audioDuration]);

  const prevFrameLenRef  = useRef(0);
  const renderStartAtRef = useRef(0);
  const pendingCommitSampleRef = useRef(false);
  if (perfTrack && streaming && frames.length !== prevFrameLenRef.current) {
    prevFrameLenRef.current = frames.length;
    // N12 시작점은 렌더 단계(커밋 전)에서 찍어야 한다 — useLayoutEffect에서 찍으면 자식
    // ReactECharts의 componentDidUpdate(자식이 부모보다 먼저 커밋됨)가 이미 setOption을
    // 호출한 뒤라 늦어서, 이번 렌더가 아니라 다음 drain 사이클의 rendered 이벤트를 붙잡아
    // N12가 항상 RENDER_INTERVAL에 가깝게 나오는 버그가 있었다.
    renderStartAtRef.current = performance.now();
    pendingCommitSampleRef.current = true;
  }
  useLayoutEffect(() => {
    if (pendingCommitSampleRef.current) {
      pendingCommitSampleRef.current = false;
      // N11 — DashboardClient가 setStreamingFrames 직전에 남긴 커밋 시각 대비, 이 레이아웃
      // 이펙트(React 커밋 이후)까지 걸린 시간.
      e2e.sampleSinceCommit("N11", "temperature");
    }
  });

  const echartsEvents = useRef<Record<string, (...args: unknown[]) => void>>({});
  echartsEvents.current = {
    rendered: useCallback(() => {
      if (perfTrack && renderStartAtRef.current > 0) {
        const renderMs = performance.now() - renderStartAtRef.current;
        perf.recordRender("temperature", renderMs);
        e2e.sample("N12", renderMs, "temperature");
        renderStartAtRef.current = 0;
      }
    }, [perfTrack]),
    datazoom: useCallback((params: unknown) => {
      const p = params as { batch?: Array<{ start?: number; end?: number }>; start?: number; end?: number };
      const src = p.batch?.[0] ?? p;
      if (src.start !== undefined && src.end !== undefined) {
        zoomRef.current = { start: src.start, end: src.end };
      }
      const next = shouldShowFrameSymbols(pointCountRef.current, zoomRef.current);
      setShowSymbols((prev) => (prev === next ? prev : next));
    }, []),
  };

  const { current: currentTemp, windowFrames } = useMemo(
    () => computeStreamWindow(frames, currentTime, isActive, streaming, audioDuration, WINDOW_SIZE, (f) => f.temperature),
    [frames, currentTime, isActive, streaming],
  );
  pointCountRef.current = windowFrames.length;

  const displayTemp = useMemo(() => {
    if (currentTemp === null) return null;
    if (channelMode === "L")    return currentTemp[0];
    if (channelMode === "R")    return currentTemp[1];
    return Math.max(currentTemp[0], currentTemp[1]);
  }, [currentTemp, channelMode]);

  const tempColor =
    displayTemp === null ? "#94A3B8"
    : displayTemp >= dangerThreshold ? "#EF4444"
    : displayTemp >= warnThreshold   ? "#F59E0B"
    : CH_COLOR[channelMode].ch0;

  const { yMin, yMax } = useMemo(
    () => computeTemperatureYRange(windowFrames, channelMode),
    [windowFrames, channelMode],
  );

  const option = useMemo(() => {
    const colors = CH_COLOR[channelMode];

    const samplingOpts = lttb ? { sampling: "lttb", large: true, largeThreshold: 2000 } : {};
    const timeDecimals = resolveTimeDecimals(windowFrames);

    const markLine = {
      silent: true,
      symbol: "none",
      data: [
        { yAxis: warnThreshold,   lineStyle: { color: "#F59E0B", type: "dashed", width: 1 }, label: { formatter: "WARN",   color: "#F59E0B", fontSize: 9 } },
        { yAxis: dangerThreshold, lineStyle: { color: "#EF4444", type: "dashed", width: 1 }, label: { formatter: "DANGER", color: "#EF4444", fontSize: 9 } },
      ],
    };

    const seriesL = buildLineSeries({
      name: "L (ch0)",
      data: windowFrames.map((f) => [f.time, f.temperature[0]]),
      color: colors.ch0, smooth: true, width: 2, sampling: samplingOpts,
      area: channelMode !== "Both" ? buildAreaGradient("rgba(11,65,113,0.18)", "rgba(11,65,113,0)") : undefined,
      markLine, showSymbol: showSymbols, symbolSize: 5,
    });

    const seriesR = buildLineSeries({
      name: "R (ch1)",
      data: windowFrames.map((f) => [f.time, f.temperature[1]]),
      color: colors.ch1, smooth: true, width: 2, sampling: samplingOpts,
      area: channelMode !== "Both" ? buildAreaGradient("rgba(107,155,209,0.18)", "rgba(107,155,209,0)") : undefined,
      showSymbol: showSymbols, symbolSize: 5,
    });

    const series =
      channelMode === "L"    ? [seriesL] :
      channelMode === "R"    ? [{ ...seriesR, markLine }] :
      [seriesL, seriesR];

    return buildBaseChartOption({
      channelMode, windowFrames, zoomRef, gridLeft: 52,
      zoomColors: { filler: "rgba(11,65,113,0.12)", handle: "#0B4171" },
      timeDecimals,
      yAxis: buildValueYAxis({ name: "°C", min: yMin, max: yMax }),
      series,
      tooltip: buildValueTooltip({ unit: "°C", decimals: 1, timeDecimals }),
    });
  }, [windowFrames, channelMode, yMin, yMax, lttb, warnThreshold, dangerThreshold, showSymbols]);

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
              aria-label="Temperature chart detail view"
              title="View details"
              className="ml-0.5 p-1 rounded text-iron-300 hover:text-brand-blue hover:bg-brand-blue/5 transition-colors"
            >
              <Maximize2 size={13} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
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
            aria-label="Temperature channel"
          />

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
            Data will appear here in real time during playback
          </div>
        )}
      </div>
    </div>
  );
}
