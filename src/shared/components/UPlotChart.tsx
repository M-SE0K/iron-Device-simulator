"use client";

import { useId, useLayoutEffect, useRef } from "react";
import "@/shared/lib/dpr-cap";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { frameScheduler } from "@/shared/lib/frame-scheduler";
import { recordPerfSample } from "@/shared/lib/iron-perf";
import { attachYZoom } from "@/shared/lib/uplot-y-zoom";

export type UPlotOptions = Omit<uPlot.Options, "width" | "height">;

/* 줌 상태에서 뷰포트 양옆으로 더 읽어둘 비율(각 방향). 스케일 변경 → 재읽기 사이의 한
 * 프레임 동안 옛 데이터가 새 범위를 덮게 한다. 휠 한 칸은 1/0.75 = 1.333 배이므로 0.5 면
 * 두 칸(1.78배)까지 커버된다. 그린 뒤 잘려나가는 구간이라 그리기 비용은 늘지 않는다
 * (uPlot 은 가시 인덱스 범위만 패스로 만든다). */
const SOURCE_OVERREAD = 0.5;

interface UPlotReadView {
  xMin: number;
  xMax: number;
  pxWidth: number;
}

export interface UPlotDataSource {
  subscribe: (cb: () => void) => () => void;
  read: (view?: UPlotReadView) => {
    data: uPlot.AlignedData;
    yRange?: [number, number];
    xFull?: [number, number];
  } | null;
}

interface Props {
  options: UPlotOptions;
  data?: uPlot.AlignedData;
  source?: UPlotDataSource;
  yRange?: [number, number];
  xRange?: [number, number];
  seriesShow?: boolean[];
  streamFollow?: boolean;
  yZoom?: boolean;
  className?: string;
}

function isZoomed(u: uPlot, xRange: [number, number] | null): boolean {
  const xs = u.data[0];
  if (!xs || xs.length < 2) return false;
  const full = xRange ?? [xs[0], xs[xs.length - 1]];
  if (!(full[1] - full[0] > 0)) return false;
  const min = u.scales.x.min ?? full[0];
  const max = u.scales.x.max ?? full[1];
  const tol = (full[1] - full[0]) * 1e-6 + 1e-12;
  return Math.abs(min - full[0]) > tol || Math.abs(max - full[1]) > tol;
}

function emptyData(options: UPlotOptions): uPlot.AlignedData {
  return options.series.map(() => []) as unknown as uPlot.AlignedData;
}

function isZoomedFollow(u: uPlot, anchorT: number, anchorWall: number): boolean {
  const xs = u.data[0];
  if (!xs || xs.length < 2) return false;
  const elapsed = Math.max(0, (performance.now() - anchorWall) / 1000);
  const expectedMax = anchorT + elapsed;
  if (!(expectedMax > 0)) return false;
  const min = u.scales.x.min ?? 0;
  const max = u.scales.x.max ?? expectedMax;
  const tol = Math.max(expectedMax * 0.02, 0.2);
  return Math.abs(min - 0) > tol || Math.abs(max - expectedMax) > tol;
}

export default function UPlotChart({ options, data, source, yRange, xRange, seriesShow, streamFollow, yZoom, className }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<uPlot | null>(null);
  const zoomedRef = useRef(false);
  const yLockRef = useRef<[number, number] | null>(null);
  const internalCommitRef = useRef(false);
  const dataRef = useRef<uPlot.AlignedData | null>(data ?? null);
  const yRangeRef = useRef<[number, number] | null>(yRange ?? null);
  const xRangeRef = useRef<[number, number] | null>(xRange ?? null);
  const sourceXFullRef = useRef<[number, number] | null>(null);
  const sourceRefreshRef = useRef<(() => void) | null>(null);
  const sourceReadRef = useRef(source?.read);
  const appliedDataRef = useRef<uPlot.AlignedData | null>(null);

  dataRef.current = data ?? null;
  sourceReadRef.current = source?.read;
  if (!source) yRangeRef.current = yRange ?? null;
  xRangeRef.current = xRange ?? null;
  const seriesShowRef = useRef(seriesShow);
  seriesShowRef.current = seriesShow;
  const streamFollowRef = useRef(streamFollow);
  streamFollowRef.current = streamFollow;

  const streamAnchorTimeRef = useRef<number | null>(null);
  const streamAnchorWallRef = useRef(0);

  const fullXRange = (): [number, number] | null => sourceXFullRef.current ?? xRangeRef.current;

  const effectiveYRange = (): [number, number] | null => yLockRef.current ?? yRangeRef.current;

  const streamMax = (): number | null => {
    const anchorT = streamAnchorTimeRef.current;
    if (anchorT == null) return null;
    return anchorT + Math.max(0, (performance.now() - streamAnchorWallRef.current) / 1000);
  };

  const applyStreamScale = (u: uPlot) => {
    const max = streamMax();
    if (max == null) return;
    u.setScale("x", { min: 0, max });
  };

  const applySeriesShow = (u: uPlot) => {
    const show = seriesShowRef.current;
    if (!show) return;
    show.forEach((s, i) => {
      const series = u.series[i + 1];
      if (series && series.show !== s) u.setSeries(i + 1, { show: s });
    });
  };

  const sizeToContainer = (u: uPlot, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const legend = u.root.querySelector<HTMLElement>(".u-legend");
    const legendHeight = legend?.offsetHeight ?? 0;
    const width = Math.max(0, Math.floor(rect.width));
    const height = Math.max(0, Math.floor(rect.height - legendHeight));
    if (width > 0 && height > 0) u.setSize({ width, height });
  };

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const merged: uPlot.Options = {
      width: Math.max(1, Math.floor(el.getBoundingClientRect().width)),
      height: Math.max(1, Math.floor(el.getBoundingClientRect().height)),
      ...options,
      scales: {
        ...options.scales,
        x: {
          time: false,
          ...options.scales?.x,
        },
        y: {
          ...options.scales?.y,
          range: (u, dataMin, dataMax) => effectiveYRange() ?? [dataMin, dataMax],
        },
      },
      hooks: {
        ...options.hooks,
        setScale: [
          ...(options.hooks?.setScale ?? []),
          (u, key) => {
            if (key !== "x") return;
            if (internalCommitRef.current) return;
            const full = fullXRange();
            const sMin = u.scales.x.min;
            const sMax = u.scales.x.max;
            const fullTol = full ? Math.max((full[1] - full[0]) * 5e-3, 0.05) : 0;
            if (
              full && sMin != null && sMax != null
              && Math.abs(sMin - full[0]) <= fullTol
              && Math.abs(sMax - full[1]) <= fullTol
            ) {
              zoomedRef.current = false;
            } else {
              const anchorT = streamAnchorTimeRef.current;
              zoomedRef.current = streamFollowRef.current && anchorT != null
                ? isZoomedFollow(u, anchorT, streamAnchorWallRef.current)
                : isZoomed(u, full);
            }
            sourceRefreshRef.current?.();
          },
        ],
      },
    };

    const seed = sourceReadRef.current?.();
    if (seed?.yRange) yRangeRef.current = seed.yRange;
    sourceXFullRef.current = seed?.xFull ?? null;
    const initialData = seed?.data ?? dataRef.current ?? emptyData(options);

    internalCommitRef.current = true;
    const u = new uPlot(merged, initialData, el);
    chartRef.current = u;
    appliedDataRef.current = initialData;
    zoomedRef.current = false;
    yLockRef.current = null;
    u.batch(() => {
      const seededXFull = fullXRange();
      if (seededXFull) u.setScale("x", { min: seededXFull[0], max: seededXFull[1] });
      applySeriesShow(u);
      sizeToContainer(u, el);
    });
    internalCommitRef.current = false;

    const ro = new ResizeObserver(() => {
      const chart = chartRef.current;
      if (!chart) return;
      internalCommitRef.current = true;
      sizeToContainer(chart, el);
      internalCommitRef.current = false;
      sourceRefreshRef.current?.();
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      u.destroy();
      chartRef.current = null;
      appliedDataRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  const commitRef = useRef<(next: uPlot.AlignedData) => void>(() => {});
  commitRef.current = (next: uPlot.AlignedData) => {
    const u = chartRef.current;
    if (!u) return;
    appliedDataRef.current = next;

    const zoomed = zoomedRef.current;
    const yR = effectiveYRange();
    const xR = fullXRange();
    const follow = streamFollowRef.current;
    const t0 = performance.now();
    if (follow && !zoomed) {
      const xs = next[0];
      if (xs && xs.length) {
        streamAnchorTimeRef.current = xs[xs.length - 1];
        streamAnchorWallRef.current = t0;
      }
    }
    internalCommitRef.current = true;
    u.batch(() => {
      u.setData(next, !zoomed);
      if (zoomed) {
        /* setData(…, false) 는 "그릴 인덱스 범위"(uPlot 내부 i0/i1)를 다시 계산하지 않는다.
         * source 모드는 커밋할 때마다 배열이 통째로 바뀌므로, 옛 배열 기준 인덱스를 그대로
         * 쓰면 새 배열의 일부만 그려져 좌우에 여백이 남는다. 같은 범위로 x 스케일을 한 번
         * 더 눌러 새 배열 기준으로 재계산시킨다(값이 같으면 setScale 훅은 안 뜬다). */
        const sMin = u.scales.x.min;
        const sMax = u.scales.x.max;
        if (sMin != null && sMax != null) u.setScale("x", { min: sMin, max: sMax });
        if (yR) u.setScale("y", { min: yR[0], max: yR[1] });
      } else if (follow) {
        applyStreamScale(u);
      } else if (xR) {
        u.setScale("x", { min: xR[0], max: xR[1] });
      }
    });
    internalCommitRef.current = false;
    recordPerfSample("chart_render", performance.now() - t0);
  };

  useLayoutEffect(() => {
    if (source || !data) return;
    if (!chartRef.current || appliedDataRef.current === data) return;
    commitRef.current(data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const subscribe = source?.subscribe;
  const taskId = useId();
  useLayoutEffect(() => {
    if (!subscribe && !streamFollow) return;

    if (streamFollow) streamAnchorWallRef.current = performance.now();

    let dataDirty = subscribe != null;
    const markDirty = () => { dataDirty = true; };

    const needsStreamScale = (): boolean => (
      streamFollowRef.current === true
      && !zoomedRef.current
      && streamAnchorTimeRef.current != null
    );

    const commitFromSource = () => {
      const u = chartRef.current;
      if (!u) return;
      const pxRatio = uPlot.pxRatio || 1;
      const plotWidth = u.bbox && u.bbox.width > 0 ? u.bbox.width / pxRatio : u.width;
      const followMax = needsStreamScale() ? streamMax() : null;
      const xMin = followMax != null ? 0 : (u.scales.x.min ?? 0);
      const xMax = followMax ?? (u.scales.x.max ?? 0);
      const span = xMax - xMin;
      const margin = zoomedRef.current && span > 0 ? span * SOURCE_OVERREAD : 0;
      const res = sourceReadRef.current?.({
        xMin: xMin - margin,
        xMax: xMax + margin,
        pxWidth: Math.max(1, Math.round(plotWidth * (1 + SOURCE_OVERREAD * 2))),
      });
      if (!res) return;
      if (res.yRange) yRangeRef.current = res.yRange;
      sourceXFullRef.current = res.xFull ?? null;
      commitRef.current(res.data);
    };

    if (subscribe) sourceRefreshRef.current = markDirty;
    const off = subscribe?.(markDirty);

    const unregister = frameScheduler.register({
      id: `uplot-chart:${taskId}`,
      phase: "draw",
      isDirty: () => dataDirty || needsStreamScale(),
      run: () => {
        const u = chartRef.current;
        if (!u) return;
        if (dataDirty) {
          dataDirty = false;
          commitFromSource();
          return;
        }
        internalCommitRef.current = true;
        u.batch(() => applyStreamScale(u));
        internalCommitRef.current = false;
      },
    });

    return () => {
      off?.();
      sourceRefreshRef.current = null;
      unregister();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, streamFollow, taskId]);

  useLayoutEffect(() => {
    const u = chartRef.current;
    if (u && seriesShow) applySeriesShow(u);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesShow?.join(",")]);

  useLayoutEffect(() => {
    const u = chartRef.current;
    if (!u) return;
    if (!zoomedRef.current && !yLockRef.current && yRange) u.setScale("y", { min: yRange[0], max: yRange[1] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yRange?.[0], yRange?.[1]]);

  useLayoutEffect(() => {
    const u = chartRef.current;
    if (!u || !yZoom) return;
    return attachYZoom(u, {
      getAuto: () => yRangeRef.current,
      apply: (range) => {
        yLockRef.current = range;
        internalCommitRef.current = true;
        u.batch(() => {
          const next = effectiveYRange();
          if (next) u.setScale("y", { min: next[0], max: next[1] });
          else u.setData(u.data, true);
        });
        internalCommitRef.current = false;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, yZoom]);

  return <div ref={containerRef} className={className} style={{ width: "100%", height: "100%", position: "relative" }} />;
}
