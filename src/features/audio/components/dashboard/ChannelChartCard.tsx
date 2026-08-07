"use client";

// 대시보드 그리드의 캡처 채널 카드 — MetricChartCard와 같은 카드 셸에 채널 파형
// (ChannelWaveformCanvas)을 담는다. 파형 데이터는 useChannelWaveStreams가 소유한
// ChannelWaveStore를 그대로 구독하고, 점 잇기(연필/지우개)는 메트릭 카드와 동일한
// useDrawMode 패턴을 쓴다.
import { useMemo } from "react";
import { channelLabel, channelColor } from "@/features/audio/lib/render/channel-meta";
import type { AnnotationStore } from "@/features/audio/lib/render/annotation-store";
import type { ChannelWaveStore } from "@/features/audio/lib/render/wave-store";
import { useDrawMode } from "@/features/audio/components/chart/hooks/useDrawMode";
import { ChannelStatsBadge, ChannelWaveformCanvas } from "@/features/audio/components/channel/ChannelWaveformCanvas";
import type { ChannelStreamHeader } from "@/features/audio/components/channel/useChannelWaveStreams";
import type { CaptureSnapshot } from "@/features/audio/components/player/capture/types";
import ChartDrawControls from "@/features/audio/components/chart/ChartDrawControls";

interface Props {
  ch: number;
  /** 세션 헤더(채널 수/샘플레이트) — 아직 캡처 이력이 없으면 null(빈 상태 표시). */
  header: ChannelStreamHeader | null;
  store: ChannelWaveStore;
  annotations: AnnotationStore;
  /** 정지/재생 종료 상태 여부 — 재생 중에는 그리기 모드에 들어갈 수 없다. */
  canAnnotate: boolean;
  /**
   * 캡처 세션의 원본 PCM 스냅샷 getter — 파형을 개별 샘플(µs)까지 확대할 때 엔벨로프
   * 대신 원본을 직접 읽는 데 쓴다. 없으면 파형은 엔벨로프 해상도까지만 보여준다.
   */
  getCaptureSnapshot?: () => CaptureSnapshot | null;
}

export default function ChannelChartCard({
  ch, header, store, annotations, canAnnotate, getCaptureSnapshot,
}: Props) {
  // 캡처 이력이 없으면(빈 상태) 연필을 보여줄 이유가 없다 — 이을 데이터 포인트 자체가 없다.
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
