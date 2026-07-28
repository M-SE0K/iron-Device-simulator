"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type uPlot from "uplot";
import UPlotChart, { type UPlotOptions } from "@/shared/components/UPlotChart";
import { buildTimeAxis, buildValueAxis, timeDecimalsForInterval } from "@/features/audio/lib/render/uplot-option";
import { tooltipPlugin, zoomPlugin } from "@/features/audio/lib/render/uplot-plugins";
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
  const [historical, setHistorical] = useState<WaveformWindow | null>(null);
  const fetchSeqRef = useRef(0);
  const debounceRef = useRef<number | null>(null);

  // 사용자 줌 콜백(안정된 참조)이 항상 최신 값을 읽을 수 있게 ref로 미러링한다.
  const liveStartRef = useRef(liveWindow.startSec);
  liveStartRef.current = liveWindow.startSec;
  const totalDurationRef = useRef(totalDurationSec);
  totalDurationRef.current = totalDurationSec;
  const fetchRangeRef = useRef(fetchRange);
  fetchRangeRef.current = fetchRange;

  // 사용자 줌(드래그/휠/더블클릭)에서만 호출된다 — 보이는 구간이 라이브 윈도우보다 과거로
  // 내려가면 그 구간만 온디맨드 디코딩해 표시한다(줌 아웃해 전체를 보면 세션 전체 백필).
  const handleUserZoom = useMemo(() => {
    return (minSec: number, maxSec: number) => {
      if (totalDurationRef.current <= 0) return;
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        const total = totalDurationRef.current;
        if (minSec < liveStartRef.current - PAST_EPSILON_SEC) {
          const seq = ++fetchSeqRef.current;
          fetchRangeRef.current(Math.max(0, minSec), Math.min(total, maxSec)).then((data) => {
            if (fetchSeqRef.current !== seq) return;
            setHistorical({ startSec: Math.max(0, minSec), data });
          });
        } else {
          fetchSeqRef.current++;
          setHistorical(null);
        }
      }, FETCH_DEBOUNCE_MS);
    };
  }, []);

  useEffect(() => () => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
  }, []);

  // options useMemo(아래)는 totalDurationSec을 deps에 넣지 않는다 — 매 캡처 청크마다
  // 늘어나는 값이라 넣으면 인스턴스가 매번 재생성된다. 대신 안정된 참조의 getter로 감싸
  // zoomPlugin이 항상 최신 값을 ref로 읽게 한다.
  const getFullXRange = useCallback((): [number, number] | null => {
    const total = totalDurationRef.current;
    return total > 0 ? [0, total] : null;
  }, []);

  const source = historical ?? liveWindow;

  const data = useMemo(() => {
    const points = buildLttb(source.data, sampleRate, source.startSec, LTTB_THRESHOLD);
    const xs = new Float64Array(points.length);
    const ys = new Float64Array(points.length);
    for (let i = 0; i < points.length; i++) {
      xs[i] = points[i][0];
      ys[i] = points[i][1];
    }
    return [xs, ys] as unknown as uPlot.AlignedData;
  }, [source.data, source.startSec, sampleRate]);

  const { yMin, yMax } = useMemo(
    () => computeSymmetricYRange(source.data),
    [source.data],
  );

  const timeDecimals = timeDecimalsForInterval(sampleRate > 0 ? 1 / sampleRate : 0);

  const options = useMemo<UPlotOptions>(() => ({
    legend: { show: false },
    cursor: { drag: { x: true, y: false } },
    series: [
      {},
      {
        label: "wave",
        stroke: color,
        width: 1,
        points: { size: 4, fill: color },
      },
    ],
    axes: [
      buildTimeAxis(timeDecimals),
      buildValueAxis({ size: 42, formatter: (v: number) => v.toFixed(3) }),
    ],
    plugins: [
      zoomPlugin({ getFullXRange }),
      tooltipPlugin({ unit: "", decimals: 4, timeDecimals }),
    ],
  }), [color, timeDecimals, getFullXRange]);

  return (
    <UPlotChart
      options={options}
      data={data}
      yRange={[yMin, yMax]}
      xRange={[0, totalDurationSec > 0 ? totalDurationSec : 0.001]}
      onUserZoom={handleUserZoom}
    />
  );
}
