"use client";

import { memo, useMemo, useState } from "react";
import type uPlot from "uplot";
import UPlotChart, { type UPlotOptions } from "@/shared/components/UPlotChart";
import type { DecodedPlayback } from "@/features/audio/lib/codec/playback-decode";
import SegmentedControl from "@/shared/components/ui/SegmentedControl";
import { buildTimeAxis, buildValueAxis } from "@/features/audio/lib/render/uplot-option";
import { symmetricYRange } from "@/features/audio/lib/render/chart-window";
import { envelopeOverlayPlugin, tooltipPlugin, zoomPlugin } from "@/features/audio/lib/render/uplot-plugins";
import type { ChannelWaveStore, WaveSnapshot } from "@/features/audio/lib/render/wave-store";
import {
  useThrottledStoreSnapshot,
  READOUT_INTERVAL_MS,
} from "@/features/audio/components/chart/hooks/useThrottledStoreSnapshot";
import type { CaptureStreamListener } from "@/features/audio/components/player/capture/types";
import { useProtectedCompareStreams } from "./hooks/useProtectedCompareStreams";

const Y_MIN_SPAN = 0.05;

type ChannelMode = "L" | "R" | "Both";

/* 전 구간 0인 시리즈는 y=0 직선이라 x축에 그대로 묻혀 "렌더링이 안 된 것"처럼 보인다.
 * 채널 카드의 ChannelLevelBadge 와 같은 취지의 경고를 비교 패널에도 둔다. */
const selectSilent = (snapshot: WaveSnapshot) => snapshot.sampleCount > 0 && snapshot.peak === 0;
const isSameSilent = (previous: boolean, next: boolean) => previous === next;

function SilentSeriesBadge({
  store, label, visible,
}: {
  store: ChannelWaveStore;
  label: string;
  visible: boolean;
}) {
  const [silent] = useThrottledStoreSnapshot(store, selectSilent, isSameSilent, READOUT_INTERVAL_MS);
  if (!visible || !silent) return null;
  return (
    <span
      className="text-[10px] font-mono text-amber-600"
      title={`${label} was exactly zero for every sample received. The chart draws it as a flat line on the x-axis, so it looks missing — check that this channel actually carries signal.`}
    >
      {`${label}: no signal`}
    </span>
  );
}

export const COLOR_INPUT_L     = "#475569";
export const COLOR_PROTECTED_L = "#2563eb";
export const COLOR_INPUT_R     = "#94A3B8";
export const COLOR_PROTECTED_R = "#d97706";

function ProtectedComparePanelImpl({
  subscribeCaptureStream,
  sourceFile,
  getDecodedPlayback,
  decodeReady = false,
  getProtectedBlob,
  hiddenSeries,
}: {
  subscribeCaptureStream: (fn: CaptureStreamListener) => () => void;
  sourceFile?: File | null;
  getDecodedPlayback?: () => DecodedPlayback | null;
  decodeReady?: boolean;
  getProtectedBlob?: () => Blob | null;
  hiddenSeries: Set<number>;
}) {
  const [channelMode, setChannelMode] = useState<ChannelMode>("Both");

  const showL = channelMode !== "R";
  const showR = channelMode !== "L";

  const { stores, getFullXRange, input } = useProtectedCompareStreams({
    subscribeCaptureStream, sourceFile, getDecodedPlayback, decodeReady, getProtectedBlob,
  });

  /* 줌해도 uPlot 에 커밋되는 데이터는 이 더미 그대로다 — 파형은 envelopeOverlayPlugin 이
   * 그리는 시점에 스토어에서 직접 읽어 캔버스에 스트로크한다(paths: () => null).
   * 덕분에 줌은 setData/패스 재생성 없이 u.redraw 한 번으로 끝난다. */
  const chartData = useMemo<uPlot.AlignedData | null>(() => {
    if (!input) return null;
    const blank = [null, null];
    return [[0, input.durationSec], blank, blank, blank, blank] as unknown as uPlot.AlignedData;
  }, [input]);

  const xRange = useMemo<[number, number] | null>(
    () => (input ? [0, input.durationSec] : null),
    [input],
  );

  const yRange = useMemo<[number, number] | null>(() => {
    if (!input) return null;
    const peak = Math.max(Y_MIN_SPAN, showL ? input.peakL : 0, showR ? input.peakR : 0);
    return symmetricYRange(peak, 0);
  }, [input, showL, showR]);

  const options = useMemo<UPlotOptions | null>(() => {
    if (!input) return null;
    const inputSeries = (label: string, color: string): uPlot.Series => ({
      label, stroke: `${color}D9`, width: 1, spanGaps: true,
      paths: () => null,
      points: { show: false },
    });
    const protectedSeries = (label: string, color: string): uPlot.Series => ({
      label, stroke: color, width: 1.8, spanGaps: true,
      paths: () => null,
      points: { size: 4, fill: color },
    });
    const { inputL, inputR, protectedL, protectedR } = stores;
    return {
      legend: { show: false },
      cursor: { drag: { x: true, y: false } },
      series: [
        {},
        inputSeries("Input L", COLOR_INPUT_L),
        inputSeries("Input R", COLOR_INPUT_R),
        protectedSeries("Protected L", COLOR_PROTECTED_L),
        protectedSeries("Protected R", COLOR_PROTECTED_R),
      ],
      axes: [
        buildTimeAxis(),
        buildValueAxis({ size: 56 }),
      ],
      plugins: [
        envelopeOverlayPlugin([
          { store: inputL, seriesIdx: 1 },
          { store: inputR, seriesIdx: 2 },
          { store: protectedL, seriesIdx: 3 },
          { store: protectedR, seriesIdx: 4 },
        ]),
        zoomPlugin({ getFullXRange }),
        tooltipPlugin({
          unit: "", decimals: 3,
          /* 캔버스에 찍힌 꼭짓점을 그대로 읽는다 — 툴팁 숫자와 마커가 같은 점을 가리키므로
           * y축을 따라 읽은 값과 어긋나지 않는다. */
          virtualSeries: [
            { label: "Input L", seriesIdx: 1, resolve: (t, v) => inputL.pointAt(v.xMin, v.xMax, v.columns, t) },
            { label: "Input R", seriesIdx: 2, resolve: (t, v) => inputR.pointAt(v.xMin, v.xMax, v.columns, t) },
            { label: "Protected L", seriesIdx: 3, resolve: (t, v) => protectedL.pointAt(v.xMin, v.xMax, v.columns, t) },
            { label: "Protected R", seriesIdx: 4, resolve: (t, v) => protectedR.pointAt(v.xMin, v.xMax, v.columns, t) },
          ],
        }),
      ],
    };
  }, [input, stores, getFullXRange]);

  const seriesShow = useMemo(
    () => [
      showL && !hiddenSeries.has(0),
      showR && !hiddenSeries.has(1),
      showL && !hiddenSeries.has(2),
      showR && !hiddenSeries.has(3),
    ],
    [showL, showR, hiddenSeries],
  );

  const placeholder = !sourceFile
    ? "Select an audio source to see the original waveform."
    : (input === null ? "Preparing original waveform…" : null);

  return (
    <div id="protected-compare-panel" className="card flex flex-col h-full">
      <div className="card-header">
        <div className="chart-title-group flex items-center gap-2 min-w-0 flex-wrap">
          <span className="card-title">Protection Algorithm</span>
          <SilentSeriesBadge store={stores.inputL}     label="Input L"     visible={seriesShow[0]} />
          <SilentSeriesBadge store={stores.inputR}     label="Input R"     visible={seriesShow[1]} />
          <SilentSeriesBadge store={stores.protectedL} label="Protected L" visible={seriesShow[2]} />
          <SilentSeriesBadge store={stores.protectedR} label="Protected R" visible={seriesShow[3]} />
        </div>

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
          aria-label="Protected channel"
        />
      </div>

      <div className="chart-body flex-1 flex flex-col min-h-[160px] p-2">
        {options && chartData && xRange && yRange && !placeholder ? (
          <div className="flex-1 min-h-0">
            <UPlotChart
              options={options}
              data={chartData}
              yRange={yRange}
              xRange={xRange}
              seriesShow={seriesShow}
              yZoom
            />
          </div>
        ) : (
          <div className="chart-empty-state h-full flex items-center justify-center text-xs text-iron-300">
            {placeholder ?? "Once analysis starts, the protected waveform will overlay here."}
          </div>
        )}
      </div>
    </div>
  );
}

export const ProtectedComparePanel = memo(ProtectedComparePanelImpl);
