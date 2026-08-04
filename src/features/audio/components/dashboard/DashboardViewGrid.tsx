"use client";

// 대시보드의 동적 차트 그리드 — View 탭에서 체크된 항목만, 고정된 정렬(Protection →
// Excursion → Temperature → 채널 오름차순)로 최대 2열에 흘려 배치한다. 행 수는 제한이
// 없다(넘치면 main이 스크롤). Protection(전/후 비교)은 항상 전체 폭이고, 1칸짜리 항목이
// 행에 혼자 남으면 전체 폭으로 늘려 빈 칸을 만들지 않는다 — 기본 선택 상태의 결과가 곧
// 예전 고정 배치(1행 Protection / 2행 Excursion·Temperature)다.
import { useMemo } from "react";
import type { CaptureStreamListener } from "@/features/audio/components/player/capture/types";
import type { ChartStore } from "@/features/audio/lib/render/chart-store";
import type { ChannelWaveStore } from "@/features/audio/lib/render/wave-store";
import type { AnnotationStore } from "@/features/audio/lib/render/annotation-store";
import type { TempThresholds } from "@/features/audio/lib/render/detect-events";
import TemperatureChart from "@/features/audio/components/chart/TemperatureChart";
import ExcursionChart from "@/features/audio/components/chart/ExcursionChart";
import { ProtectedComparePanel } from "@/features/audio/components/channel/ProtectedComparePanel";
import type { ChannelStreamHeader } from "@/features/audio/components/channel/useChannelWaveStreams";
import ChannelChartCard from "./ChannelChartCard";
import {
  VIEW_PROTECTED,
  VIEW_EXCURSION,
  VIEW_TEMPERATURE,
  parseViewChannelId,
  viewChannelId,
} from "./hooks/useDashboardView";

interface Props {
  selected: Set<string>;
  chartStore: ChartStore;
  isActive: boolean;
  isPlaying: boolean;
  /** 메트릭 차트의 점 잇기 활성 조건 — 정지 상태이면서 그릴 프레임이 있을 때. */
  canAnnotateMetric: boolean;
  audioDuration: number | null;
  tempThresholds: TempThresholds;
  audioFile: File | null;
  subscribeChannelStream: (fn: CaptureStreamListener) => () => void;
  getProtectedBlob: () => Blob | null;
  channelHeader: ChannelStreamHeader | null;
  getWaveStore: (ch: number) => ChannelWaveStore;
  getAnnotationStore: (id: string) => AnnotationStore;
}

interface GridCell {
  id: string;
  span: 1 | 2;
}

/** 체크된 항목을 고정 정렬로 나열하고 2열 흐름의 스팬(전체 폭 여부)을 계산한다. */
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
    cells.push({ id: pending, span: 2 }); // 짝이 없는 1칸 항목은 전체 폭으로 늘린다
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
  tempThresholds,
  audioFile,
  subscribeChannelStream,
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
      return (
        <ProtectedComparePanel
          subscribeCaptureStream={subscribeChannelStream}
          sourceFile={audioFile}
          getProtectedBlob={getProtectedBlob}
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
          perfTrack
          annotations={getAnnotationStore(id)}
          canAnnotate={canAnnotateMetric}
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
          perfTrack
          warnThreshold={tempThresholds.warn}
          dangerThreshold={tempThresholds.danger}
          annotations={getAnnotationStore(id)}
          canAnnotate={canAnnotateMetric}
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
