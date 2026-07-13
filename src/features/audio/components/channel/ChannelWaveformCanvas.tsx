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
import { buildDataZoom, buildDynamicTimeFormatter, buildValueTooltip, timeDecimalsForInterval, SYMBOL_VISIBLE_MAX } from "@/features/audio/lib/render/chart-option";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

// LTTB 출력 점 개수(다운샘플 상한) — 원본을 이 개수의 "대표 1점"으로 줄여 단일 선을 만든다.
// 줌인 시에도 동일 데이터를 다시 그리므로 실제 표시 해상도는 dataZoom이 축 범위를 좁히는 것과
// 별개다. 필요하면 더 늘려도 되지만 충분히 촘촘함.
const LTTB_THRESHOLD = 2000;
// dataZoom이 실시간 윈도우 시작점보다 과거로 넘어갔다고 판단하는 여유(초) — 경계에서
// 자잘하게 fetchRange를 반복 호출하지 않기 위한 허용 오차.
const PAST_EPSILON_SEC = 0.05;
// dataZoom 드래그 중 매 이벤트마다 재요청하지 않도록 안정화 대기 시간(ms).
const FETCH_DEBOUNCE_MS = 200;
// Y축 동적 범위 여유(대칭 피크의 배수) — Temperature/Excursion의 패딩과 같은 취지.
const Y_SCALE_PADDING = 1.1;
// 무음/저진폭 구간에서 노이즈가 화면을 가득 채우지 않도록 두는 최소 대칭 스팬(±).
const Y_MIN_SPAN = 0.01;

/**
 * 원본 절대 피크 기준 대칭 Y축 범위 — 0을 중심으로 진동하는 파형에 맞춘 동적 스케일.
 * LTTB 다운샘플은 전역 최대 샘플을 놓칠 수 있으므로, 범위는 다운샘플 결과가 아니라
 * 원본 데이터로 계산해 피크가 잘리지 않도록 한다.
 */
function computeSymmetricYRange(data: Float32Array): { yMin: number; yMax: number } {
  let peak = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
  const yMax = Math.max(peak * Y_SCALE_PADDING, Y_MIN_SPAN);
  return { yMin: -yMax, yMax };
}

export interface WaveformWindow {
  /** 이 배열의 첫 샘플이 세션 시작 기준 몇 초 지점인지 */
  startSec: number;
  data: Float32Array;
}

/**
 * LTTB(Largest Triangle Three Buckets) 다운샘플 — 원본 샘플을 버킷당 "대표 1점"으로 줄여
 * 한 시각당 값이 하나인 단일 선 파형을 만든다(Temperature/Excursion 차트와 동일한 규약).
 * 첫/끝 점은 항상 보존하고, 나머지는 직전 선택 점 + 다음 버킷 평균점과 이루는 삼각형 넓이가
 * 최대인 샘플을 골라 파형의 시각적 형태(피크 포함)를 유지한다. x좌표는 인덱스에 선형이므로
 * 시각(초)으로 환산해 [t, v]로 반환한다. 원본을 ECharts에 넘기기 전에 미리 줄이는 사전
 * 다운샘플이라, 라이브 윈도우가 수십만~백만 샘플이어도 전달 비용을 이 개수로 상한한다.
 */
function buildLttb(
  data: Float32Array,
  sampleRate: number,
  startSec: number,
  threshold: number,
): [number, number][] {
  const n = data.length;
  if (n === 0 || sampleRate <= 0) return [];
  const timeAt = (i: number) => startSec + i / sampleRate;

  // 목표 점 수가 원본보다 많으면(또는 너무 작으면) 그대로 반환 — 이미 한 시각당 한 점.
  if (threshold >= n || threshold <= 2) {
    const pts: [number, number][] = new Array(n);
    for (let i = 0; i < n; i++) pts[i] = [timeAt(i), data[i]];
    return pts;
  }

  const sampled: [number, number][] = [[timeAt(0), data[0]]]; // 첫 점 고정
  const bucketSize = (n - 2) / (threshold - 2);
  let a = 0; // 직전에 선택된 점의 인덱스

  for (let i = 0; i < threshold - 2; i++) {
    // 다음 버킷의 평균점(삼각형의 세 번째 꼭짓점)
    const avgStart = Math.floor((i + 1) * bucketSize) + 1;
    const avgEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n);
    const avgLen = Math.max(avgEnd - avgStart, 1);
    let avgX = 0, avgY = 0;
    for (let j = avgStart; j < avgEnd; j++) { avgX += timeAt(j); avgY += data[j]; }
    avgX /= avgLen; avgY /= avgLen;

    // 이번 버킷 범위에서 (직전 점, 평균점)과 이루는 삼각형 넓이가 최대인 점 선택
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

  sampled.push([timeAt(n - 1), data[n - 1]]); // 끝 점 고정
  return sampled;
}

/** 한 채널을 LTTB 단일 선으로(Temperature/Excursion과 동일한 규약) 줌 가능 ECharts에 그린다. */
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
  // 확대해서 보이는 포인트가 충분히 벌어졌을 때만 각 포인트에 점을 표시(샘플 간격 시인용).
  // x축 도메인이 전체 세션 길이라 줌 비율만으로는 밀도를 알 수 없으므로, 보이는 시간 구간
  // 안에 실제로 들어오는 포인트 수를 세어 판정한다.
  const [showSymbols, setShowSymbols] = useState(false);
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

  // 현재 렌더의 points/전체 길이를 이벤트·효과가 최신으로 읽을 수 있게 ref로 미러링한다.
  const pointsRef = useRef<[number, number][]>([]);
  const totalDurationRef = useRef(totalDurationSec);
  totalDurationRef.current = totalDurationSec;

  // 현재 줌 구간에 들어오는 포인트 수를 세어 점 표시 여부를 갱신 — 임계값을 넘나들 때만 setState.
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
      const p = params as { batch?: Array<{ start?: number; end?: number }>; start?: number; end?: number };
      const src = p.batch?.[0] ?? p;
      if (src.start !== undefined && src.end !== undefined) {
        zoomRef.current = { start: src.start, end: src.end };
        resolveZoom(src.start, src.end);
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
  // 데이터(과거 스냅샷 로드 등)나 전체 길이가 바뀌면 밀도가 달라지므로 점 표시를 재판정한다.
  useEffect(() => { recomputeSymbols(); }, [points, totalDurationSec, recomputeSymbols]);

  const { yMin, yMax } = useMemo(
    () => computeSymmetricYRange(source.data),
    [source.data],
  );

  // 원본 파형의 실제 시간 해상도 = 1/sampleRate(샘플 간격) — 데이터 해상도 상한. 실제 표시
  // 자릿수는 여기에 더해 현재 줌 구간 폭에 맞춰 동적으로 정해진다(buildDynamicTimeFormatter).
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
        // 확대 상태(showSymbols)면 각 포인트에 점을 찍어 샘플 간격이 보이게 한다. 이때는
        // large/LTTB 샘플링이 심볼을 무시·솎아내므로 끈다(보이는 포인트가 이미 적음).
        symbol: showSymbols ? "circle" : "none",
        showSymbol: showSymbols,
        symbolSize: 4,
        itemStyle: { color },
        // 이미 LTTB로 사전 축소했지만 Temperature/Excursion과 동일하게 draw-cost 상한도 둔다.
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

export function channelStats(data: Float32Array): { peak: number; rms: number } {
  let peak = 0, sumSq = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
    sumSq += data[i] * data[i];
  }
  return { peak, rms: data.length ? Math.sqrt(sumSq / data.length) : 0 };
}
