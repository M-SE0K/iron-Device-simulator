"use client";

import { useMemo, useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import { Maximize2 } from "lucide-react";
import { AnalysisFrame } from "@/features/audio/types";
import ReactECharts from "@/shared/components/ReactECharts";
import { toMm, MM_DECIMALS } from "@/features/audio/lib/units";
import { perf } from "@/features/audio/lib/perf/collector";
import { e2e } from "@/features/audio/lib/perf-e2e/collector";
import {
  computeStreamWindow, computeExcursionYRange, WINDOW_SIZE,
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
}

const SCALE_PADDING = 1.15;

const EXC_COLOR = "#10B981";

export default function ExcursionChart({ frames, currentTime, isActive, streaming = false, audioDuration, lttb = true, perfTrack = false, onExpand }: Props) {
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
      e2e.sampleSinceCommit("N11", "excursion");
    }
  });

  const echartsEvents = useRef<Record<string, (...args: unknown[]) => void>>({});
  echartsEvents.current = {
    rendered: useCallback(() => {
      if (perfTrack && renderStartAtRef.current > 0) {
        const renderMs = performance.now() - renderStartAtRef.current;
        perf.recordRender("excursion", renderMs);
        e2e.sample("N12", renderMs, "excursion");
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

  const { current: currentExc, windowFrames } = useMemo(
    () => computeStreamWindow(frames, currentTime, isActive, streaming, audioDuration, WINDOW_SIZE, (f) => f.excursion),
    [frames, currentTime, isActive, streaming],
  );
  pointCountRef.current = windowFrames.length;

  const { yMin, yMax } = useMemo(
    () => computeExcursionYRange(windowFrames, toMm, SCALE_PADDING),
    [windowFrames],
  );

  const displayExc = currentExc;

  const excColor =
    displayExc !== null && Math.abs(toMm(displayExc)) > Math.abs(yMax) * 0.85
      ? "#EF4444"
      : EXC_COLOR;

  const option = useMemo(() => {
    const samplingOpts = lttb ? { sampling: "lttb" as const, large: true, largeThreshold: 2000 } : {};
    const timeDecimals = resolveTimeDecimals(windowFrames);

    const series = buildLineSeries({
      name: "Excursion",
      data: windowFrames.map((f) => [f.time, toMm(f.excursion)]),
      color: EXC_COLOR, smooth: 0.3, width: 1.5, sampling: samplingOpts,
      area: buildAreaGradient("rgba(16,185,129,0.15)", "rgba(16,185,129,0)"),
      showSymbol: showSymbols, symbolSize: 4,
    });

    return buildBaseChartOption({
      windowFrames, zoomRef, gridLeft: 60,
      zoomColors: { filler: "rgba(16,185,129,0.12)", handle: "#10B981" },
      timeDecimals,
      yAxis: buildValueYAxis({ name: "mm", min: yMin, max: yMax, labelFormatter: (v: number) => v.toFixed(MM_DECIMALS) }),
      series: [series],
      tooltip: buildValueTooltip({ unit: "mm", decimals: MM_DECIMALS, timeDecimals }),
    });
  }, [windowFrames, yMin, yMax, lttb, showSymbols]);

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
              aria-label="Excursion chart detail view"
              title="View details"
              className="ml-0.5 p-1 rounded text-iron-300 hover:text-emerald-600 hover:bg-emerald-50 transition-colors"
            >
              <Maximize2 size={13} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {displayExc !== null ? (
            <span id="current-excursion-value" className="font-mono text-lg font-semibold" style={{ color: excColor }}>
              {toMm(displayExc).toFixed(MM_DECIMALS)}<span className="text-xs ml-0.5 font-normal text-iron-400">mm</span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="chart-body flex-1 p-2 min-h-[160px]">
        {showChart ? (
          <ReactECharts option={option} style={{ height: "100%", width: "100%" }} notMerge={false} onEvents={echartsEvents.current} />
        ) : (
          <div className="chart-empty-state h-full flex items-center justify-center text-xs text-iron-300">
            Data will appear here in real time during playback
          </div>
        )}
      </div>
    </div>
  );
}
