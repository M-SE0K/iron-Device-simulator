"use client";

// 채널 파형 뷰 — ChannelWaveStore가 들고 있는 **세션 전체** min/max 엔벨로프를 그대로 그린다
// (메인 차트가 ChartStore를 source로 구독하는 것과 같은 경로 — React 커밋 없이 rAF로 커밋).
// 줌은 Temperature/ExcursionChart와 동일하게 기본 zoomPlugin()(휠/드래그/더블클릭, 전체범위
// = 현재 로드된 데이터 extent)만 쓴다 — 확대 시 원본 해상도를 별도로 재조회하지 않는다.
import { useMemo } from "react";
import type uPlot from "uplot";
import UPlotChart, { type UPlotDataSource, type UPlotOptions } from "@/shared/components/UPlotChart";
import { buildTimeAxis, buildValueAxis, timeDecimalsForInterval } from "@/features/audio/lib/render/uplot-option";
import { annotatePlugin, tooltipPlugin, zoomPlugin } from "@/features/audio/lib/render/uplot-plugins";
import type { AnnotationStore } from "@/features/audio/lib/render/annotation-store";
import type { ChannelWaveStore } from "@/features/audio/lib/render/wave-store";
import { ChannelLevelBadge } from "./ChannelRowHeader";
import { useThrottledStoreSnapshot } from "@/features/audio/components/chart/hooks/useThrottledStoreSnapshot";

const Y_SCALE_PADDING = 1.1;
const Y_MIN_SPAN = 0.01;

function symmetricYRange(peak: number): [number, number] {
  const yMax = Math.max(peak * Y_SCALE_PADDING, Y_MIN_SPAN);
  return [-yMax, yMax];
}

/**
 * 스토어에서 "React 상태로 들고 있어야 하는 값"만 낮은 빈도로 읽어온다 — 파형 자체는
 * source 경로로 React를 거치지 않고 커밋되므로, 리렌더가 필요한 건 x축 전체 도메인(세션
 * 길이)과 헤더 숫자뿐이다. 메인 차트의 useMetricChartRuntime과 같은 주기/이유다.
 */
const READOUT_INTERVAL_MS = 100;

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
  annotations,
  isDrawEnabled,
}: {
  color: string;
  sampleRate: number;
  store: ChannelWaveStore;
  /** 점 잇기 주석 스토어 — 연필 토글은 부모 카드가 소유하고 여기는 플러그인만 단다. */
  annotations?: AnnotationStore;
  /** 그리기 모드 getter — 반드시 안정된 참조여야 한다(옵션 재생성 방지). */
  isDrawEnabled?: () => boolean;
}) {
  // Temperature/ExcursionChart와 같은 source 경로 — 스토어가 들고 있는 엔벨로프를 그대로
  // 커밋한다. 확대해도 별도 원본 재조회 없이 zoomPlugin()의 기본 동작(휠/드래그/더블클릭,
  // 전체범위 = 현재 로드된 데이터 extent)만 적용된다.
  const source = useMemo<UPlotDataSource>(() => ({
    subscribe: store.subscribe,
    read: () => {
      const snap = store.snapshot();
      return {
        data: store.readAligned() as unknown as uPlot.AlignedData,
        yRange: symmetricYRange(snap.peak),
      };
    },
  }), [store]);

  const timeDecimals = timeDecimalsForInterval(sampleRate > 0 ? 1 / sampleRate : 0);

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
      zoomPlugin(),
      tooltipPlugin({ unit: "", decimals: 4, timeDecimals }),
      ...(annotations && isDrawEnabled
        ? [annotatePlugin({ store: annotations, isEnabled: isDrawEnabled })]
        : []),
    ],
  }), [color, timeDecimals, annotations, isDrawEnabled]);

  return <UPlotChart options={options} source={source} />;
}

/**
 * 채널 헤더의 peak/rms 배지. 최근 구간이 아니라 **세션 누적값**이다 — 스토어가 압축과
 * 무관하게 원본 샘플 기준으로 들고 있는 값을 그대로 보여준다. 표시 규칙(아주 작은 값의
 * 지수 표기, 전부 0일 때의 경고)은 저장본 뷰어와 같은 배지를 공유한다.
 */
export function ChannelStatsBadge({ store }: { store: ChannelWaveStore }) {
  const { peak, rms, sampleCount } = useWaveReadout(store);
  if (sampleCount === 0) return null;
  return <ChannelLevelBadge peak={peak} rms={rms} />;
}
