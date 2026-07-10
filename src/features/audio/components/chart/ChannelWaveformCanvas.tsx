"use client";

// 채널 원본(V/I 등) 파형 렌더링 — Temperature/Excursion 차트와 동일한 ECharts dataZoom
// (마우스 휠 줌 + 하단 슬라이더로 구간별 보기)을 그대로 재사용한다. x축은 항상 전체 세션
// 길이(totalDurationSec)를 도메인으로 삼지만, 실제로 메모리에 들고 있는 데이터는 호출자가
// 넘겨주는 liveWindow(최근 N초, 계속 갱신됨) 뿐이다 — 사용자가 dataZoom으로 그 창 밖(과거)
// 을 보려고 하면 fetchRange로 그 구간만 온디맨드로 다시 디코딩해 보여준다(과거 전체를
// 메모리에 들고 있지 않아도 됨). ChannelViewerOverlay(저장 세션의 전 채널 뷰)와
// ChannelStackView(ChartDetailOverlay의 실시간 채널 선택 뷰)가 공유한다.
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildDataZoom, buildValueTooltip } from "@/features/audio/lib/render/chart-option";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

// 엔벨로프 버킷 개수 — 다운샘플링 상한(줌인 시에도 동일 데이터를 다시 그리므로, 실제 표시
// 해상도는 dataZoom이 축 범위만 좁히는 것과 별개다. 필요하면 더 늘려도 되지만 충분히 촘촘함).
const ENVELOPE_BUCKETS = 2000;
// dataZoom이 실시간 윈도우 시작점보다 과거로 넘어갔다고 판단하는 여유(초) — 경계에서
// 자잘하게 fetchRange를 반복 호출하지 않기 위한 허용 오차.
const PAST_EPSILON_SEC = 0.05;
// dataZoom 드래그 중 매 이벤트마다 재요청하지 않도록 안정화 대기 시간(ms).
const FETCH_DEBOUNCE_MS = 200;

export interface WaveformWindow {
  /** 이 배열의 첫 샘플이 세션 시작 기준 몇 초 지점인지 */
  startSec: number;
  data: Float32Array;
}

function buildEnvelope(
  data: Float32Array,
  sampleRate: number,
  startSec: number,
): { maxPoints: [number, number][]; minPoints: [number, number][] } {
  const n = data.length;
  const maxPoints: [number, number][] = [];
  const minPoints: [number, number][] = [];
  if (n === 0 || sampleRate <= 0) return { maxPoints, minPoints };

  const buckets = Math.min(ENVELOPE_BUCKETS, n);
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b / buckets) * n);
    const end = Math.max(start + 1, Math.floor(((b + 1) / buckets) * n));
    let min = Infinity, max = -Infinity;
    for (let i = start; i < end; i++) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const t = startSec + (start + end) / 2 / sampleRate;
    maxPoints.push([t, max]);
    minPoints.push([t, min]);
  }
  return { maxPoints, minPoints };
}

/** 한 채널의 min/max 엔벨로프를 Temperature/Excursion과 동일한 줌 가능 ECharts로 그린다. */
export function ChannelWaveformCanvas({
  color,
  sampleRate,
  totalDurationSec,
  liveWindow,
  fetchRange,
}: {
  color: string;
  sampleRate: number;
  /** x축 전체 도메인(초) — 세션이 진행되며 계속 늘어난다 */
  totalDurationSec: number;
  /** 최근 N초 실시간 윈도우 — 주기적으로 갱신된다 */
  liveWindow: WaveformWindow;
  /** 라이브 윈도우 밖(과거) 구간을 온디맨드로 디코딩해 반환 */
  fetchRange: (startSec: number, endSec: number) => Promise<Float32Array>;
}) {
  // ── 줌 상태 보존 — Temperature/ExcursionChart와 동일 패턴(ref로 관리해 렌더 유발 없이 반영) ──
  const zoomRef = useRef({ start: 0, end: 100 });
  // 과거 구간을 확대했을 때만 채워지는 온디맨드 스냅샷 — 라이브 윈도우로 돌아오면 비운다.
  const [historical, setHistorical] = useState<WaveformWindow | null>(null);
  const fetchSeqRef = useRef(0);
  const debounceRef = useRef<number | null>(null);

  const resolveZoom = useCallback((startPct: number, endPct: number) => {
    if (totalDurationSec <= 0) return;
    const zoomStartSec = (startPct / 100) * totalDurationSec;
    const zoomEndSec = (endPct / 100) * totalDurationSec;

    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      if (zoomStartSec < liveWindow.startSec - PAST_EPSILON_SEC) {
        const seq = ++fetchSeqRef.current;
        fetchRange(Math.max(0, zoomStartSec), Math.min(totalDurationSec, zoomEndSec)).then((data) => {
          if (fetchSeqRef.current !== seq) return; // 그 사이 다른 구간으로 다시 줌됨 — 폐기
          setHistorical({ startSec: Math.max(0, zoomStartSec), data });
        });
      } else {
        fetchSeqRef.current++; // 진행 중이던 과거 구간 요청 폐기
        setHistorical(null); // 실시간 윈도우로 복귀
      }
    }, FETCH_DEBOUNCE_MS);
  }, [totalDurationSec, liveWindow.startSec, fetchRange]);

  useEffect(() => () => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
  }, []);

  const echartsEvents = useRef<Record<string, (...args: unknown[]) => void>>({});
  echartsEvents.current = {
    datazoom: useCallback((params: unknown) => {
      const p = params as { batch?: Array<{ start?: number; end?: number }>; start?: number; end?: number };
      const src = p.batch?.[0] ?? p;
      if (src.start !== undefined && src.end !== undefined) {
        zoomRef.current = { start: src.start, end: src.end };
        resolveZoom(src.start, src.end);
      }
    }, [resolveZoom]),
  };

  const source = historical ?? liveWindow;
  const { maxPoints, minPoints } = useMemo(
    () => buildEnvelope(source.data, sampleRate, source.startSec),
    [source.data, source.startSec, sampleRate],
  );

  const option = useMemo(() => ({
    animation: false,
    grid: { top: 8, right: 12, bottom: 40, left: 42 },
    dataZoom: buildDataZoom(zoomRef.current, { filler: "rgba(148, 163, 184, 0.15)", handle: color }),
    xAxis: {
      type: "value" as const,
      min: 0,
      max: totalDurationSec > 0 ? totalDurationSec : 0.001,
      axisLabel: { formatter: (v: number) => `${v.toFixed(2)}s`, color: "#94A3B8", fontSize: 9 },
      axisLine: { lineStyle: { color: "#E2E8F0" } },
      splitLine: { lineStyle: { color: "#F1F5F9" } },
    },
    yAxis: {
      type: "value" as const,
      min: -1,
      max: 1,
      axisLabel: { formatter: (v: number) => v.toFixed(1), color: "#94A3B8", fontSize: 9 },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: "#F1F5F9" } },
    },
    series: [
      { name: "max", type: "line" as const, data: maxPoints, showSymbol: false, lineStyle: { color, width: 1 } },
      { name: "min", type: "line" as const, data: minPoints, showSymbol: false, lineStyle: { color, width: 1 } },
    ],
    tooltip: buildValueTooltip({ unit: "", decimals: 4 }),
  }), [maxPoints, minPoints, totalDurationSec, color]);

  return (
    <ReactECharts
      option={option}
      style={{ height: "100%", width: "100%" }}
      notMerge={false}
      onEvents={echartsEvents.current}
    />
  );
}

export function channelStats(data: Float32Array): { peak: number; rms: number } {
  let peak = 0, sumSq = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
    sumSq += data[i] * data[i];
  }
  return { peak, rms: data.length ? Math.sqrt(sumSq / data.length) : 0 };
}
