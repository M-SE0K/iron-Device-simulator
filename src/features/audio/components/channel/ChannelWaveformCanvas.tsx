"use client";

// 채널 파형 뷰 — 기본 화면은 ChannelWaveStore가 들고 있는 **세션 전체** min/max 엔벨로프다
// (메인 차트가 ChartStore를 source로 구독하는 것과 같은 경로 — React 커밋 없이 rAF로 커밋).
// 사용자가 충분히 확대하면 그 구간만 캡처 WAV에서 원본 해상도로 디코딩해 덮어 보여준다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type uPlot from "uplot";
import UPlotChart, { type UPlotDataSource, type UPlotOptions } from "@/shared/components/UPlotChart";
import { buildTimeAxis, buildValueAxis, timeDecimalsForInterval } from "@/features/audio/lib/render/uplot-option";
import { tooltipPlugin, zoomPlugin } from "@/features/audio/lib/render/uplot-plugins";
import type { ChannelWaveStore } from "@/features/audio/lib/render/wave-store";

const LTTB_THRESHOLD = 2000;
const FETCH_DEBOUNCE_MS = 200;
const Y_SCALE_PADDING = 1.1;
const Y_MIN_SPAN = 0.01;
/**
 * 확대 구간이 이 길이 이하일 때만 원본 해상도로 다시 디코딩한다. 더 넓게 보고 있으면
 * 엔벨로프만으로 충분하고(그 구간을 원본으로 받아봐야 어차피 2000점으로 다시 줄인다),
 * 디코딩 비용/메모리만 커진다 — 48 kHz 기준 30초 ≈ 5.8 MB.
 */
const RAW_ZOOM_MAX_SPAN_SEC = 30;

function symmetricYRange(peak: number): [number, number] {
  const yMax = Math.max(peak * Y_SCALE_PADDING, Y_MIN_SPAN);
  return [-yMax, yMax];
}

function peakOf(data: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
  return peak;
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

function toAligned(data: Float32Array, sampleRate: number, startSec: number): uPlot.AlignedData {
  const points = buildLttb(data, sampleRate, startSec, LTTB_THRESHOLD);
  const xs = new Float64Array(points.length);
  const ys = new Float64Array(points.length);
  for (let i = 0; i < points.length; i++) {
    xs[i] = points[i][0];
    ys[i] = points[i][1];
  }
  return [xs, ys] as unknown as uPlot.AlignedData;
}

/**
 * 스토어에서 "React 상태로 들고 있어야 하는 값"만 낮은 빈도로 읽어온다 — 파형 자체는
 * source 경로로 React를 거치지 않고 커밋되므로, 리렌더가 필요한 건 x축 전체 도메인(세션
 * 길이)과 헤더 숫자뿐이다. 메인 차트의 useMetricChartRuntime과 같은 주기/이유다.
 */
const READOUT_INTERVAL_MS = 100;

function useWaveReadout(store: ChannelWaveStore) {
  const [snap, setSnap] = useState(() => store.snapshot());

  useEffect(() => {
    let timer: number | null = null;
    let lastVersion = -1;

    const sync = () => {
      timer = null;
      const next = store.snapshot();
      if (next.version === lastVersion) return;
      lastVersion = next.version;
      setSnap(next);
    };
    const onUpdate = () => { if (timer === null) timer = window.setTimeout(sync, READOUT_INTERVAL_MS); };

    const off = store.subscribe(onUpdate);
    sync(); // 늦게 마운트된 뷰가 현재 상태를 즉시 반영하도록
    return () => {
      off();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [store]);

  return snap;
}

export function ChannelWaveformCanvas({
  color,
  sampleRate,
  store,
  fetchRange,
}: {
  color: string;
  sampleRate: number;
  store: ChannelWaveStore;
  fetchRange: (startSec: number, endSec: number) => Promise<Float32Array>;
}) {
  // 확대 구간의 원본 해상도 데이터. React 상태가 아니라 ref다 — 데이터 커밋 경로가
  // source(rAF)로 일원화돼 있어 상태로 들고 있을 이유가 없다.
  const zoomedDataRef = useRef<{ data: uPlot.AlignedData; yRange: [number, number] } | null>(null);
  const fetchSeqRef = useRef(0);
  const debounceRef = useRef<number | null>(null);
  const fetchRangeRef = useRef(fetchRange);
  fetchRangeRef.current = fetchRange;

  // zoomedDataRef가 바뀐 것을 source 구독자(uPlot)에게 알리기 위한 로컬 알림 채널 —
  // 스토어 갱신(라이브 청크)과 같은 커밋 경로를 공유한다.
  const localListeners = useRef(new Set<() => void>());
  const notifyLocal = useCallback(() => { localListeners.current.forEach((fn) => fn()); }, []);

  useEffect(() => {
    // 채널이 바뀌면(스토어 교체) 이전 채널의 확대 데이터를 들고 있지 않는다.
    zoomedDataRef.current = null;
    fetchSeqRef.current++;
    notifyLocal();
  }, [store, notifyLocal]);

  useEffect(() => () => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
  }, []);

  const source = useMemo<UPlotDataSource>(() => ({
    subscribe: (cb: () => void) => {
      const offStore = store.subscribe(cb);
      localListeners.current.add(cb);
      return () => { offStore(); localListeners.current.delete(cb); };
    },
    read: () => {
      const zoomed = zoomedDataRef.current;
      if (zoomed) return zoomed;
      const snap = store.snapshot();
      return {
        data: store.readAligned() as unknown as uPlot.AlignedData,
        yRange: symmetricYRange(snap.peak),
      };
    },
  }), [store]);

  // 사용자 줌(드래그/휠/더블클릭)에서만 호출된다 — 충분히 확대했을 때만 그 구간을 원본
  // 해상도로 받아오고, 다시 넓히면 세션 전체 엔벨로프로 돌아간다.
  const handleUserZoom = useCallback((minSec: number, maxSec: number, zoomed: boolean) => {
    const span = maxSec - minSec;
    // 되돌아가는 방향(줌 아웃)은 디바운스하지 않는다 — 기다릴 데이터가 없고, 확대 구간이
    // 남아 있는 채로 200ms를 끌면 더블클릭 리셋이 눈에 띄게 늦게 반영된다.
    if (!zoomed || !(span > 0) || span > RAW_ZOOM_MAX_SPAN_SEC) {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
      fetchSeqRef.current++;
      if (zoomedDataRef.current) { zoomedDataRef.current = null; notifyLocal(); }
      return;
    }

    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      const total = store.snapshot().durationSec;
      const start = Math.max(0, minSec);
      const end = Math.min(total > 0 ? total : maxSec, maxSec);
      if (!(end > start)) return;

      const seq = ++fetchSeqRef.current;
      fetchRangeRef.current(start, end).then((data) => {
        if (fetchSeqRef.current !== seq) return;
        if (data.length === 0) return;
        zoomedDataRef.current = {
          data: toAligned(data, sampleRate, start),
          yRange: symmetricYRange(peakOf(data)),
        };
        notifyLocal();
      }).catch(() => { /* 확대 구간 디코딩 실패 시 엔벨로프를 그대로 유지한다 */ });
    }, FETCH_DEBOUNCE_MS);
  }, [store, sampleRate, notifyLocal]);

  // options useMemo는 세션 길이를 의존성에 넣지 않는다 — 매 청크마다 늘어나는 값이라 넣으면
  // uPlot 인스턴스가 매번 재생성된다. 대신 안정된 참조의 getter로 감싸 스토어에서 직접 읽는다.
  const getFullXRange = useCallback((): [number, number] | null => {
    const total = store.snapshot().durationSec;
    return total > 0 ? [0, total] : null;
  }, [store]);

  const timeDecimals = timeDecimalsForInterval(sampleRate > 0 ? 1 / sampleRate : 0);

  // x축 전체 도메인은 항상 [0, 세션 길이]다 — 지금 화면에 어떤 데이터(전체 엔벨로프 /
  // 확대 구간 원본)가 올라가 있든 무관하게. UPlotChart는 이 값으로 "사용자가 줌한 상태인가"를
  // 판정하고, 줌이 아니면 커밋마다 x를 여기에 맞춰 세션이 길어지는 대로 따라간다.
  const { durationSec } = useWaveReadout(store);
  const xRange = useMemo<[number, number] | undefined>(
    () => (durationSec > 0 ? [0, durationSec] : undefined),
    [durationSec],
  );

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
      source={source}
      xRange={xRange}
      onUserZoom={handleUserZoom}
    />
  );
}

/**
 * 채널 헤더의 peak/rms 배지. 최근 구간이 아니라 **세션 누적값**이다 — 스토어가 압축과
 * 무관하게 원본 샘플 기준으로 들고 있는 값을 그대로 보여준다.
 */
export function ChannelStatsBadge({ store }: { store: ChannelWaveStore }) {
  const { peak, rms, sampleCount } = useWaveReadout(store);
  if (sampleCount === 0) return null;
  return (
    <span className="ml-auto text-[10px] font-mono text-iron-400">
      peak {peak.toFixed(4)} · rms {rms.toFixed(4)}
    </span>
  );
}
