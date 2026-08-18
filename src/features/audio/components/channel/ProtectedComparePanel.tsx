"use client";

import { memo, useMemo, useState } from "react";
import type uPlot from "uplot";
import UPlotChart, { type UPlotOptions } from "@/shared/components/UPlotChart";
import type { DecodedPlayback } from "@/features/audio/lib/codec/playback-decode";
import SegmentedControl from "@/shared/components/ui/SegmentedControl";
import { buildTimeAxis, buildValueAxis } from "@/features/audio/lib/render/uplot-option";
import { symmetricYRange } from "@/features/audio/lib/render/chart-window";
import { envelopeOverlayPlugin, tooltipPlugin, zoomPlugin } from "@/features/audio/lib/render/uplot-plugins";
import type { CaptureStreamListener } from "@/features/audio/components/player/capture/types";
import { useProtectedCompareStreams } from "./hooks/useProtectedCompareStreams";

const Y_MIN_SPAN = 0.05;

type ChannelMode = "L" | "R" | "Both";

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
  const { stores, input } = useProtectedCompareStreams({
    subscribeCaptureStream, sourceFile, getDecodedPlayback, decodeReady, getProtectedBlob,
  });

  const showL = channelMode !== "R";
  const showR = channelMode !== "L";

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
    const peak = Math.max(
      Y_MIN_SPAN,
      showL ? input.peakL : 0,
      showR ? input.peakR : 0,
    );
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
        zoomPlugin({ getFullXRange: () => [0, input.durationSec] }),
        tooltipPlugin({
          unit: "", decimals: 3,
          virtualSeries: [
            { label: "Input L", seriesIdx: 1, resolve: (t) => inputL.valueAt(t) },
            { label: "Input R", seriesIdx: 2, resolve: (t) => inputR.valueAt(t) },
            { label: "Protected L", seriesIdx: 3, resolve: (t) => protectedL.valueAt(t) },
            { label: "Protected R", seriesIdx: 4, resolve: (t) => protectedR.valueAt(t) },
          ],
        }),
      ],
    };
  }, [input, stores]);

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
        <div className="chart-title-group flex items-center gap-2">
          <span className="card-title">Protection Algorithm</span>
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
