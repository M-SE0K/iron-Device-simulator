"use client";

import { useMemo } from "react";
import { channelLabel, channelColor } from "@/features/audio/lib/render/channel-meta";
import type { AnnotationStore } from "@/features/audio/lib/render/annotation-store";
import type { ChannelWaveStore } from "@/features/audio/lib/render/wave-store";
import { useDrawMode } from "@/features/audio/components/chart/hooks/useDrawMode";
import { ChannelStatsBadge, ChannelWaveformCanvas } from "@/features/audio/components/channel/ChannelWaveformCanvas";
import type { ChannelStreamHeader } from "@/features/audio/components/channel/hooks/useChannelWaveStreams";
import type { CaptureSnapshot } from "@/features/audio/components/player/capture/types";
import ChartDrawControls from "@/features/audio/components/chart/ChartDrawControls";

interface Props {
  ch: number;
  header: ChannelStreamHeader | null;
  store: ChannelWaveStore;
  annotations: AnnotationStore;
  canAnnotate: boolean;
  getCaptureSnapshot?: () => CaptureSnapshot | null;
}

export default function ChannelChartCard({
  ch, header, store, annotations, canAnnotate, getCaptureSnapshot,
}: Props) {
  const { isEnabled, draw } = useDrawMode(annotations, canAnnotate && header !== null);
  const { name, role } = channelLabel(ch, {
    voltage: "V (Voltage)",
    current: "I (Current)",
    extended: "Extended",
  });
  const color = channelColor(ch);
  const raw = useMemo(
    () => (getCaptureSnapshot ? { getSnapshot: getCaptureSnapshot, channel: ch } : undefined),
    [getCaptureSnapshot, ch],
  );

  return (
    <div id={`channel-chart-${ch}`} className="card flex flex-col h-full">
      <div className="card-header">
        <div className="chart-title-group flex items-center gap-2 min-w-0">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
          <span className="card-title font-mono">{name}</span>
          <span className="text-[11px] text-iron-400 shrink-0">{role}</span>
          <ChartDrawControls chartLabel={name} draw={draw} />
        </div>
        <ChannelStatsBadge store={store} />
      </div>

      <div className="chart-body flex-1 p-2 min-h-[160px]">
        {header ? (
          <ChannelWaveformCanvas
            color={color}
            sampleRate={header.sampleRate}
            store={store}
            raw={raw}
            annotations={annotations}
            isDrawEnabled={isEnabled}
          />
        ) : (
          <div className="chart-empty-state h-full flex items-center justify-center text-xs text-iron-300">
            Channel waveform will appear here once capture starts
          </div>
        )}
      </div>
    </div>
  );
}
