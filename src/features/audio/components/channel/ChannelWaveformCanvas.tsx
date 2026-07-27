"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactECharts from "@/shared/components/ReactECharts";
import { buildDataZoom, buildDynamicTimeFormatter, buildValueTooltip, extractZoomState, timeDecimalsForInterval, SYMBOL_VISIBLE_MAX } from "@/features/audio/lib/render/chart-option";
import type { WaveformWindow } from "@/features/audio/lib/render/waveform";

const LTTB_THRESHOLD = 2000;
const PAST_EPSILON_SEC = 0.05;
const FETCH_DEBOUNCE_MS = 200;
const Y_SCALE_PADDING = 1.1;
const Y_MIN_SPAN = 0.01;

function computeSymmetricYRange(data: Float32Array): { yMin: number; yMax: number } {
  let peak = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
  const yMax = Math.max(peak * Y_SCALE_PADDING, Y_MIN_SPAN);
  return { yMin: -yMax, yMax };
}

function buildLttb(
  data: Float32Array,
  sampleRate: number,
  startSec: number,
  threshold: number,
): [number, number][] {
  const n = data.length;
  if (n === 0 || sampleRate <= 0) return [];
  const timeAt = (i: number) => startSec + i / sampleRate;

  if (threshold >= n || threshold <= 2) {
    const pts: [number, number][] = new Array(n);
    for (let i = 0; i < n; i++) pts[i] = [timeAt(i), data[i]];
    return pts;
  }

  const sampled: [number, number][] = [[timeAt(0), data[0]]];
  const bucketSize = (n - 2) / (threshold - 2);
  let a = 0;

  for (let i = 0; i < threshold - 2; i++) {
    const avgStart = Math.floor((i + 1) * bucketSize) + 1;
    const avgEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n);
    const avgLen = Math.max(avgEnd - avgStart, 1);
    let avgX = 0, avgY = 0;
    for (let j = avgStart; j < avgEnd; j++) { avgX += timeAt(j); avgY += data[j]; }
    avgX /= avgLen; avgY /= avgLen;

    const rangeStart = Math.floor(i * bucketSize) + 1;
    const rangeEnd = Math.floor((i + 1) * bucketSize) + 1;
    const pointAX = timeAt(a), pointAY = data[a];
    let maxArea = -1, nextA = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const area = Math.abs(
        (pointAX - avgX) * (data[j] - pointAY) - (pointAX - timeAt(j)) * (avgY - pointAY),
      );
      if (area > maxArea) { maxArea = area; nextA = j; }
    }
    sampled.push([timeAt(nextA), data[nextA]]);
    a = nextA;
  }

  sampled.push([timeAt(n - 1), data[n - 1]]);
  return sampled;
}

export function ChannelWaveformCanvas({
  color,
  sampleRate,
  totalDurationSec,
  liveWindow,
  fetchRange,
}: {
  color: string;
  sampleRate: number;
  totalDurationSec: number;
  liveWindow: WaveformWindow;
  fetchRange: (startSec: number, endSec: number) => Promise<Float32Array>;
}) {
  const zoomRef = useRef({ start: 0, end: 100 });
  const [showSymbols, setShowSymbols] = useState(false);
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
          if (fetchSeqRef.current !== seq) return;
          setHistorical({ startSec: Math.max(0, zoomStartSec), data });
        });
      } else {
        fetchSeqRef.current++;
        setHistorical(null);
      }
    }, FETCH_DEBOUNCE_MS);
  }, [totalDurationSec, liveWindow.startSec, fetchRange]);

  useEffect(() => () => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
  }, []);

  const pointsRef = useRef<[number, number][]>([]);
  const totalDurationRef = useRef(totalDurationSec);
  totalDurationRef.current = totalDurationSec;

  const recomputeSymbols = useCallback(() => {
    const total = totalDurationRef.current;
    if (total <= 0) { setShowSymbols((prev) => (prev ? false : prev)); return; }
    const z = zoomRef.current;
    const startSec = (z.start / 100) * total;
    const endSec = (z.end / 100) * total;
    let count = 0;
    for (const [t] of pointsRef.current) {
      if (t >= startSec && t <= endSec) { count++; if (count > SYMBOL_VISIBLE_MAX) break; }
    }
    const next = count > 0 && count <= SYMBOL_VISIBLE_MAX;
    setShowSymbols((prev) => (prev === next ? prev : next));
  }, []);

  const echartsEvents = useRef<Record<string, (...args: unknown[]) => void>>({});
  echartsEvents.current = {
    datazoom: useCallback((params: unknown) => {
      const zoom = extractZoomState(params);
      if (zoom) {
        zoomRef.current = zoom;
        resolveZoom(zoom.start, zoom.end);
        recomputeSymbols();
      }
    }, [resolveZoom, recomputeSymbols]),
  };

  const source = historical ?? liveWindow;
  const points = useMemo(
    () => buildLttb(source.data, sampleRate, source.startSec, LTTB_THRESHOLD),
    [source.data, source.startSec, sampleRate],
  );
  pointsRef.current = points;
  useEffect(() => { recomputeSymbols(); }, [points, totalDurationSec, recomputeSymbols]);

  const { yMin, yMax } = useMemo(
    () => computeSymmetricYRange(source.data),
    [source.data],
  );

  const timeDecimals = timeDecimalsForInterval(sampleRate > 0 ? 1 / sampleRate : 0);
  const timeDomain = { dataMin: 0, dataMax: totalDurationSec > 0 ? totalDurationSec : 0.001, dataDecimals: timeDecimals };

  const option = useMemo(() => ({
    animation: false,
    grid: { top: 8, right: 12, bottom: 40, left: 42 },
    dataZoom: buildDataZoom(zoomRef, { filler: "rgba(148, 163, 184, 0.15)", handle: color }, timeDomain),
    xAxis: {
      type: "value" as const,
      min: 0,
      max: totalDurationSec > 0 ? totalDurationSec : 0.001,
      axisLabel: { formatter: buildDynamicTimeFormatter(zoomRef, timeDomain), color: "#94A3B8", fontSize: 9 },
      axisLine: { lineStyle: { color: "#E2E8F0" } },
      splitLine: { lineStyle: { color: "#F1F5F9" } },
    },
    yAxis: {
      type: "value" as const,
      min: yMin,
      max: yMax,
      axisLabel: { formatter: (v: number) => v.toFixed(3), color: "#94A3B8", fontSize: 9 },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: "#F1F5F9" } },
    },
    series: [
      {
        name: "wave",
        type: "line" as const,
        data: points,
        symbol: showSymbols ? "circle" : "none",
        showSymbol: showSymbols,
        symbolSize: 4,
        itemStyle: { color },
        ...(showSymbols ? {} : { sampling: "lttb" as const, large: true, largeThreshold: 2000 }),
        lineStyle: { color, width: 1 },
      },
    ],
    tooltip: buildValueTooltip({ unit: "", decimals: 4, timeDecimals }),
  }), [points, totalDurationSec, color, yMin, yMax, timeDecimals, showSymbols]);

  return (
    <ReactECharts
      option={option}
      style={{ height: "100%", width: "100%" }}
      notMerge={false}
      onEvents={echartsEvents.current}
    />
  );
}
