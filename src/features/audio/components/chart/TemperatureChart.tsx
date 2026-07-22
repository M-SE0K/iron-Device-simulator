"use client";

import { useMemo, useLayoutEffect, useRef, useCallback, useState, useEffect } from "react";
import { Maximize2 } from "lucide-react";
import { AnalysisFrame } from "@/features/audio/types";
import ReactECharts from "@/shared/components/ReactECharts";
import SegmentedControl from "@/shared/components/ui/SegmentedControl";
import { perf } from "@/features/audio/lib/perf/collector";
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
  /** true: 스트리밍 append 모드 — 마지막 N 프레임 슬라이딩 윈도우 */
  streaming?: boolean;
  /** 오디오 총 길이(초) — 표시용(헤더/showChart 판단), X축 범위 계산에는 쓰이지 않는다 */
  audioDuration?: number | null;
  /** LTTB 다운샘플링 on/off (측정 A/B용, 기본 on) */
  lttb?: boolean;
  /**
   * true면 5단계 지연 측정(lib/perf)의 "ECharts 렌더" 표본을 이 인스턴스가 기록한다 —
   * 대시보드 본체 차트만 켠다(ChartDetailOverlay가 재사용하는 인스턴스는 중복 집계 방지로 끔).
   */
  perfTrack?: boolean;
  /** 설정 시 헤더에 "자세히 보기" 확대 버튼을 렌더 → 클릭 시 상세 뷰 전환 */
  onExpand?: () => void;
  /** 온도 WARN 임계값(°C) — Calibration.tempWarn. 미지정 시 기본값(65°C) */
  warnThreshold?: number;
  /** 온도 DANGER 임계값(°C) — Calibration.tempDanger. 미지정 시 기본값(75°C) */
  dangerThreshold?: number;
}

// 채널별 색상
const CH_COLOR: Record<ChannelMode, { ch0: string; ch1: string }> = {
  L:    { ch0: "#0B4171", ch1: "#0B4171" },
  R:    { ch0: "#6B9BD1", ch1: "#6B9BD1" },
  Both: { ch0: "#0B4171", ch1: "#6B9BD1" },
};

export default function TemperatureChart({ frames, currentTime, isActive, streaming = false, audioDuration, lttb = true, perfTrack = false, onExpand, warnThreshold = DEFAULT_TEMP_WARN, dangerThreshold = DEFAULT_TEMP_DANGER }: Props) {
  const [channelMode, setChannelMode] = useState<ChannelMode>("Both");

  // ── 줌 상태 보존 — ref로 관리해서 렌더 유발 없이 option에 반영 ────────────
  const zoomRef = useRef({ start: 0, end: 100 });
  // 확대해서 프레임이 충분히 벌어졌을 때만 각 프레임 위치에 점을 표시(프레임 간격 시인용).
  // 임계값을 넘나들 때만 setState → 매 줌마다 리렌더하지 않는다.
  const [showSymbols, setShowSymbols] = useState(false);
  const pointCountRef = useRef(0);
  // 새 파일 로드(audioDuration 변경) 시 줌 초기화 + 점 표시도 해제
  useEffect(() => { zoomRef.current = { start: 0, end: 100 }; setShowSymbols(false); }, [audioDuration]);

  // ── 5. ECharts 렌더 측정 — 새 프레임 커밋(useLayoutEffect) 시각을 찍고, 그 커밋에 이어지는
  // 첫 "rendered" 이벤트(캔버스 드로잉 완료)에서 경과를 기록한다. 렌더 틱당 표본 1개.
  const prevFrameLenRef  = useRef(0);
  const renderStartAtRef = useRef(0);
  useLayoutEffect(() => {
    if (perfTrack && streaming && frames.length !== prevFrameLenRef.current) {
      prevFrameLenRef.current = frames.length;
      renderStartAtRef.current = performance.now();
    }
  });

  // ── ECharts 이벤트 핸들러 ────────────────────────────────────────────────
  const echartsEvents = useRef<Record<string, (...args: unknown[]) => void>>({});
  echartsEvents.current = {
    rendered: useCallback(() => {
      if (perfTrack && renderStartAtRef.current > 0) {
        perf.recordRender("temperature", performance.now() - renderStartAtRef.current);
        renderStartAtRef.current = 0; // 줌/리사이즈 등 프레임 커밋 없는 redraw는 집계하지 않는다
      }
    }, [perfTrack]),
    // datazoom 이벤트에서 현재 줌 상태를 ref에 저장 + 프레임 점 표시 여부 갱신
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

  // ── 현재 값 & 윈도우 계산 ────────────────────────────────────────────────
  const { current: currentTemp, windowFrames } = useMemo(
    () => computeStreamWindow(frames, currentTime, isActive, streaming, audioDuration, WINDOW_SIZE, (f) => f.temperature),
    [frames, currentTime, isActive, streaming],
  );
  pointCountRef.current = windowFrames.length;

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
      /* Both */               [seriesL, seriesR];

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
