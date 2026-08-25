"use client";

import type { SpeakerFault } from "@/features/audio/types";
import { useMemo } from "react";
import type { CaptureSnapshot, CaptureStreamListener } from "@/features/audio/components/player/capture/types";
import type { DecodedPlayback } from "@/features/audio/lib/codec/playback-decode";
import type { ChartStore } from "@/features/audio/lib/render/chart-store";
import type { ChannelWaveStore } from "@/features/audio/lib/render/wave-store";
import type { AnnotationStore } from "@/features/audio/lib/render/annotation-store";
import type { MetricThresholds } from "@/features/audio/lib/render/detect-events";
import TemperatureChart from "@/features/audio/components/chart/TemperatureChart";
import ExcursionChart from "@/features/audio/components/chart/ExcursionChart";
import { ProtectedComparePanel } from "@/features/audio/components/channel/ProtectedComparePanel";
import type { ChannelStreamHeader } from "@/features/audio/components/channel/hooks/useChannelWaveStreams";
import ChannelChartCard from "./ChannelChartCard";
import {
  VIEW_PROTECTED,
  VIEW_EXCURSION,
  VIEW_TEMPERATURE,
  PROTECTED_SERIES_IDS,
  parseViewChannelId,
  viewChannelId,
} from "./hooks/useDashboardView";

interface Props {
  selected: Set<string>;
  chartStore: ChartStore;
  isActive: boolean;
  isPlaying: boolean;
  canAnnotateMetric: boolean;
  audioDuration: number | null;
  metricThresholds: MetricThresholds;
  speakerFault: SpeakerFault | null;
  audioFile: File | null;
  subscribeChannelStream: (fn: CaptureStreamListener) => () => void;
  getChannelsSnapshot: () => CaptureSnapshot | null;
  getDecodedPlayback: () => DecodedPlayback | null;
  getProtectedBlob: () => Blob | null;
  channelHeader: ChannelStreamHeader | null;
  getWaveStore: (ch: number) => ChannelWaveStore;
  getAnnotationStore: (id: string) => AnnotationStore;
}

interface GridCell {
  id: string;
  span: 1 | 2;
}

function computeCells(selected: Set<string>): GridCell[] {
  const channels = Array.from(selected)
    .map(parseViewChannelId)
    .filter((ch): ch is number => ch !== null)
    .sort((a, b) => a - b);
  const orderedIds = [
    ...[VIEW_PROTECTED, VIEW_EXCURSION, VIEW_TEMPERATURE].filter((id) => selected.has(id)),
    ...channels.map(viewChannelId),
  ];

  const cells: GridCell[] = [];
  let pending: string | null = null;
  const flushPending = () => {
    if (pending === null) return;
    cells.push({ id: pending, span: 2 });
    pending = null;
  };
  for (const id of orderedIds) {
    if (id === VIEW_PROTECTED) {
      flushPending();
      cells.push({ id, span: 2 });
    } else if (pending === null) {
      pending = id;
    } else {
      cells.push({ id: pending, span: 1 }, { id, span: 1 });
      pending = null;
    }
  }
  flushPending();
  return cells;
}

export default function DashboardViewGrid({
  selected,
  chartStore,
  isActive,
  isPlaying,
  canAnnotateMetric,
  audioDuration,
  metricThresholds,
  speakerFault,
  audioFile,
  subscribeChannelStream,
  getChannelsSnapshot,
  getDecodedPlayback,
  getProtectedBlob,
  channelHeader,
  getWaveStore,
  getAnnotationStore,
}: Props) {
  const cells = useMemo(() => computeCells(selected), [selected]);

  if (cells.length === 0) {
    return (
      <div
        id="dashboard-grid"
        className="flex items-center justify-center lg:flex-1 min-h-[264px] rounded-xl border border-dashed border-iron-200 text-xs text-iron-400 text-center px-6"
      >
        No charts selected — pick items to display from the View tab in the sidebar.
      </div>
    );
  }

  const renderItem = (id: string) => {
    if (id === VIEW_PROTECTED) {
      const hiddenSeries = new Set(
        PROTECTED_SERIES_IDS.flatMap((subId, i) => (selected.has(subId) ? [] : [i])),
      );
      return (
        <ProtectedComparePanel
          subscribeCaptureStream={subscribeChannelStream}
          sourceFile={audioFile}
          getDecodedPlayback={getDecodedPlayback}
          decodeReady={audioDuration !== null}
          getProtectedBlob={getProtectedBlob}
          hiddenSeries={hiddenSeries}
        />
      );
    }
    if (id === VIEW_EXCURSION) {
      return (
        <ExcursionChart
          store={chartStore}
          isActive={isActive}
          streaming={isPlaying}
          audioDuration={audioDuration}
          xmax={metricThresholds.xmax}
          annotations={getAnnotationStore(id)}
          canAnnotate={canAnnotateMetric}
          speakerFault={speakerFault}
        />
      );
    }
    if (id === VIEW_TEMPERATURE) {
      return (
        <TemperatureChart
          store={chartStore}
          isActive={isActive}
          streaming={isPlaying}
          audioDuration={audioDuration}
          tmax={metricThresholds.tmax}
          annotations={getAnnotationStore(id)}
          canAnnotate={canAnnotateMetric}
          speakerFault={speakerFault}
        />
      );
    }
    const ch = parseViewChannelId(id);
    if (ch === null) return null;
    return (
      <ChannelChartCard
        ch={ch}
        header={channelHeader}
        store={getWaveStore(ch)}
        annotations={getAnnotationStore(id)}
        canAnnotate={!isPlaying}
        getCaptureSnapshot={getChannelsSnapshot}
        speakerFault={speakerFault}
      />
    );
  };

  return (
    <div
      id="dashboard-grid"
      className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:flex-1 lg:auto-rows-[minmax(248px,1fr)]"
    >
      {cells.map(({ id, span }) => (
        <div
          key={id}
          className={`${id === VIEW_PROTECTED ? "h-[280px]" : "h-[264px]"} lg:h-auto lg:min-h-0 ${
            span === 2 ? "lg:col-span-2" : ""
          }`}
        >
          {renderItem(id)}
        </div>
      ))}
    </div>
  );
}
