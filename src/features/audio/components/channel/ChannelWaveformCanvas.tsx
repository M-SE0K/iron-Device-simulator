"use client";

import { useCallback, useMemo, useRef } from "react";
import type uPlot from "uplot";
import UPlotChart, { type UPlotDataSource, type UPlotOptions } from "@/shared/components/UPlotChart";
import { buildTimeAxis, buildValueAxis } from "@/features/audio/lib/render/uplot-option";
import { annotatePlugin, tooltipPlugin, zoomPlugin } from "@/features/audio/lib/render/uplot-plugins";
import type { AnnotationStore } from "@/features/audio/lib/render/annotation-store";
import { createReadBuffer, SEED_PX_WIDTH, type SeriesReadBuffer } from "@/features/audio/lib/render/read-buffer";
import type { ChannelWaveStore } from "@/features/audio/lib/render/wave-store";
import { readRawWindow } from "@/features/audio/lib/render/raw-window";
import { symmetricYRange } from "@/features/audio/lib/render/chart-window";
import type { CaptureSnapshot } from "@/features/audio/components/player/capture/types";
import { ChannelLevelBadge } from "./ChannelLevelBadge";
import { READOUT_INTERVAL_MS, useThrottledStoreSnapshot } from "@/features/audio/components/chart/hooks/useThrottledStoreSnapshot";

const Y_MIN_SPAN = 0.01;

const RAW_SAMPLES_PER_PX = 2;

const MIN_VISIBLE_SAMPLES = 16;

export interface ChannelRawSource {
  getSnapshot: () => CaptureSnapshot | null;
  channel: number;
}

function readRawIfZoomedIn(
  raw: ChannelRawSource | undefined,
  xMin: number,
  xMax: number,
  columns: number,
  out: SeriesReadBuffer,
): number {
  if (!raw) return 0;
  const span = xMax - xMin;
  if (!(span > 0)) return 0;
  const snap = raw.getSnapshot();
  if (!snap || raw.channel >= snap.channels) return 0;
  if ((span * snap.sampleRate) / columns >= RAW_SAMPLES_PER_PX) return 0;
  return readRawWindow(snap, raw.channel, xMin, xMax, out);
}

const selectWaveSnapshot = (snapshot: ReturnType<ChannelWaveStore["snapshot"]>) => snapshot;
const isSameWaveSnapshot = (
  previous: ReturnType<ChannelWaveStore["snapshot"]>,
  next: ReturnType<ChannelWaveStore["snapshot"]>,
) => previous === next;

function useWaveReadout(store: ChannelWaveStore) {
  const [snapshot] = useThrottledStoreSnapshot(
    store,
    selectWaveSnapshot,
    isSameWaveSnapshot,
    READOUT_INTERVAL_MS,
  );
  return snapshot;
}

export function ChannelWaveformCanvas({
  color,
  sampleRate,
  store,
  raw,
  annotations,
  isDrawEnabled,
}: {
  color: string;
  sampleRate: number;
  store: ChannelWaveStore;
  raw?: ChannelRawSource;
  annotations?: AnnotationStore;
  isDrawEnabled?: () => boolean;
}) {
  const rawRef = useRef<ChannelRawSource | undefined>(raw);
  rawRef.current = raw;

  const bufRef = useRef<SeriesReadBuffer | null>(null);

  const source = useMemo<UPlotDataSource>(() => ({
    subscribe: store.subscribe,
    read: (view) => {
      const snap = store.snapshot();
      const buf = (bufRef.current ??= createReadBuffer());

      const xMin = view ? view.xMin : 0;
      const xMax = view && view.xMax > view.xMin ? view.xMax : snap.durationSec;
      const columns = Math.max(1, Math.round(view?.pxWidth ?? SEED_PX_WIDTH));

      const rawCount = readRawIfZoomedIn(rawRef.current, xMin, xMax, columns, buf);
      const count = rawCount > 0 ? rawCount : store.readRange(xMin, xMax, columns * 2, buf);

      return {
        data: [buf.xs.subarray(0, count), buf.ys.subarray(0, count)] as unknown as uPlot.AlignedData,
        yRange: symmetricYRange(snap.peak, Y_MIN_SPAN),
        ...(snap.durationSec > 0 ? { xFull: [0, snap.durationSec] as [number, number] } : {}),
      };
    },
  }), [store]);

  const getFullXRange = useCallback((): [number, number] | null => {
    const durationSec = store.snapshot().durationSec;
    return durationSec > 0 ? [0, durationSec] : null;
  }, [store]);

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
      buildTimeAxis(),
      buildValueAxis({ size: 42 }),
    ],
    plugins: [
      zoomPlugin({
        getFullXRange,
        minXRange: sampleRate > 0 ? MIN_VISIBLE_SAMPLES / sampleRate : undefined,
      }),
      tooltipPlugin({ unit: "", decimals: 4 }),
      ...(annotations && isDrawEnabled
        ? [annotatePlugin({ store: annotations, isEnabled: isDrawEnabled })]
        : []),
    ],
  }), [color, sampleRate, getFullXRange, annotations, isDrawEnabled]);

  return <UPlotChart options={options} source={source} yZoom />;
}

export function ChannelStatsBadge({ store }: { store: ChannelWaveStore }) {
  const { peak, rms, sampleCount } = useWaveReadout(store);
  if (sampleCount === 0) return null;
  return <ChannelLevelBadge peak={peak} rms={rms} />;
}
