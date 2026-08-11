"use client";

// 채널 파형 뷰 — 줌 레벨에 따라 **두 해상도**를 오간다(Adobe Audition이 축소 뷰에서는
// peak file(.pkf) 요약을, 확대 뷰에서는 디스크 원본을 seek해 읽는 것과 같은 전략):
//
//   - 축소(픽셀당 샘플 ≥ RAW_SAMPLES_PER_PX): ChannelWaveStore의 min/max 엔벨로프를
//     readAligned()로 읽어 세션 전체를 그린다. 반환된 두 배열은 정확한 길이의 복사본이라
//     이후 스토어 갱신과 독립적으로 uPlot이 안전하게 들고 있을 수 있다.
//   - 확대(픽셀당 샘플 < RAW_SAMPLES_PER_PX): 엔벨로프는 버킷 폭 아래로 못 내려가므로
//     캡처 원본 PCM을 직접 슬라이스해 개별 샘플을 그린다(raw-window.ts). 48 kHz에서
//     1샘플 = 20.83 µs이고, 시간축은 초 단위를 유지한 채 소수점만 그만큼 늘어난다.
//
// 원본 소스(raw)가 없으면(저장본 뷰어, 브라우저 dev) 조용히 엔벨로프만 쓴다.
import { useCallback, useMemo, useRef } from "react";
import type uPlot from "uplot";
import UPlotChart, { type UPlotDataSource, type UPlotOptions } from "@/shared/components/UPlotChart";
import { buildTimeAxis, buildValueAxis } from "@/features/audio/lib/render/uplot-option";
import { annotatePlugin, tooltipPlugin, zoomPlugin } from "@/features/audio/lib/render/uplot-plugins";
import type { AnnotationStore } from "@/features/audio/lib/render/annotation-store";
import { createReadBuffer, type SeriesReadBuffer } from "@/features/audio/lib/render/read-buffer";
import type { ChannelWaveStore } from "@/features/audio/lib/render/wave-store";
import { readRawWindow } from "@/features/audio/lib/render/raw-window";
import { computeSymmetricYRange } from "@/features/audio/lib/render/chart-window";
import type { CaptureSnapshot } from "@/features/audio/components/player/capture/types";
import { ChannelLevelBadge } from "./ChannelRowHeader";
import {
  DEFAULT_STORE_READOUT_INTERVAL_MS,
  useThrottledStoreSnapshot,
} from "@/features/audio/components/chart/hooks/useThrottledStoreSnapshot";

const Y_SCALE_PADDING = 1.1;
const Y_MIN_SPAN = 0.01;

/**
 * 픽셀당 샘플 수가 이 값 미만이면 엔벨로프 대신 원본 샘플을 그린다. 1이 아니라 2인 것은
 * 여유폭이다 — 1 근처에서는 엔벨로프의 버킷 하나가 픽셀 하나보다 넓어 요약이 오히려 원본보다
 * 거칠어지기 시작한다.
 */
const RAW_SAMPLES_PER_PX = 2;

/** 확대 하한 — 화면에 최소 이만큼의 샘플은 남긴다(무한 줌인 방지). */
const MIN_VISIBLE_SAMPLES = 16;

/** 인스턴스가 아직 없어 view 없이 시드로 읽힐 때 쓸 기본 픽셀 폭. */
const SEED_PX_WIDTH = 1024;

/**
 * 원본 PCM 직독 소스. 라이브 캡처 세션에만 있고(저장본 뷰어에는 없다), getSnapshot은
 * 반드시 **안정된 참조**여야 한다 — read() 클로저가 ref로 들고 있으므로 매 렌더 새 함수를
 * 넘겨도 uPlot 인스턴스가 재생성되지는 않지만, 호출부에서 useCallback으로 고정하는 편이
 * 스냅샷 getter의 수명을 추적하기 쉽다.
 */
export interface ChannelRawSource {
  getSnapshot: () => CaptureSnapshot | null;
  /** 이 파형이 보고 있는 캡처 채널 인덱스. */
  channel: number;
}

/**
 * 확대 임계를 넘었으면 원본 샘플을 out에 채우고 개수를, 아니면 0을 돌려준다.
 * 0이면 호출부가 엔벨로프 경로로 폴백한다.
 */
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

/**
 * 스토어에서 "React 상태로 들고 있어야 하는 값"만 낮은 빈도로 읽어온다 — 파형 자체는
 * source 경로로 React를 거치지 않고 커밋되므로, 리렌더가 필요한 건 헤더 숫자뿐이다.
 * 메인 차트의 useMetricChartRuntime과 같은 주기/이유다.
 */
function useWaveReadout(store: ChannelWaveStore) {
  const [snapshot] = useThrottledStoreSnapshot(
    store,
    selectWaveSnapshot,
    isSameWaveSnapshot,
    DEFAULT_STORE_READOUT_INTERVAL_MS,
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
  /** 원본 PCM 직독 소스 — 넘기면 확대 시 개별 샘플까지 보인다. 없으면 엔벨로프 해상도까지만. */
  raw?: ChannelRawSource;
  /** 점 잇기 주석 스토어 — 연필 토글은 부모 카드가 소유하고 여기는 플러그인만 단다. */
  annotations?: AnnotationStore;
  /** 그리기 모드 getter — 반드시 안정된 참조여야 한다(옵션 재생성 방지). */
  isDrawEnabled?: () => boolean;
}) {
  // read()는 옵션이 아니라 UPlotChart의 ref로만 호출되므로, raw가 매 렌더 새 객체여도
  // 인스턴스가 재생성되지 않게 ref로 미러링한다(UPlotChart가 props를 다루는 방식과 동일).
  const rawRef = useRef<ChannelRawSource | undefined>(raw);
  rawRef.current = raw;

  // 원본 PCM 직독 경로의 커밋 페이로드를 담을 버퍼 한 쌍 — 이 캔버스만 소유하고 매 커밋
  // 재사용한다. 엔벨로프 폴백은 스토어가 readAligned()에서 만든 독립 복사본을 직접 쓴다.
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
      const data = rawCount > 0
        ? [buf.xs.subarray(0, rawCount), buf.ys.subarray(0, rawCount)] as unknown as uPlot.AlignedData
        : store.readAligned() as unknown as uPlot.AlignedData;

      return {
        data,
        yRange: computeSymmetricYRange(snap.peak, Y_MIN_SPAN, Y_SCALE_PADDING),
        // 엔벨로프 폴백은 세션 전체를 싣지만, 원본 PCM 직독 경로는 확대된 구간만 싣는다.
        // 어느 경로에서도 줌 판정과 줌아웃 복원의 기준이 흔들리지 않게 전체 길이를 명시한다.
        ...(snap.durationSec > 0 ? { xFull: [0, snap.durationSec] as [number, number] } : {}),
      };
    },
  }), [store]);

  // zoomPlugin의 줌아웃·더블클릭 복원 기준을 현재 커밋 데이터의 extent와 분리해,
  // 엔벨로프/원본 PCM 어느 경로에서도 항상 스토어의 세션 전체 길이로 되돌아가게 한다.
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
        // 원본 샘플까지 확대하면 uPlot이 점 간격을 보고 알아서 마커를 띄운다 —
        // "여기서부터는 개별 샘플"이라는 표시가 별도 코드 없이 나온다.
        points: { size: 4, fill: color },
      },
    ],
    axes: [
      buildTimeAxis(),
      buildValueAxis({ size: 42, formatter: (v: number) => v.toFixed(3) }),
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
