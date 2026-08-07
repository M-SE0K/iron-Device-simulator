import { useMemo, useRef } from "react";
import type uPlot from "uplot";
import type { UPlotDataSource } from "@/shared/components/UPlotChart";
import { createReadBuffer, type SeriesReadBuffer } from "@/features/audio/lib/render/read-buffer";
import type { ChartMetric, ChartSnapshot, ChartStore } from "@/features/audio/lib/render/chart-store";

/** 인스턴스가 아직 없어 view 없이 시드로 읽힐 때 쓸 기본 픽셀 폭. */
const SEED_PX_WIDTH = 1024;

/**
 * Temperature/ExcursionChart가 공유하는 uPlot 데이터 소스 — React 상태를 거치지 않고
 * ChartStore에서 직접 읽어 uPlot에 커밋한다(구독은 store.subscribe, 커밋 페이로드는 매
 * rAF마다 read()가 만든다). 두 차트가 다른 건 어떤 메트릭 컬럼을 읽는지(metric),
 * 값 변환이 필요한지(transform — Excursion의 mm 변환), y축 범위를 어떻게 계산하는지
 * (computeYRange)뿐이다.
 *
 * 읽기는 **지금 보이는 x 구간만, 화면 폭만큼의 점으로** 한다(store.readRange). 채널 파형과
 * 같은 전략이다 — 예전에는 커밋마다 스토어 전체를 새 배열 두 개로 복사해(점 상한 30,000
 * 기준 커밋당 480 KB) uPlot에 넘겼고, 화면 폭이 1,000 px 남짓인데 3만 점을 매번 다시
 * 경로로 빌드했다. 이제 커밋당 할당이 없고 uPlot이 그리는 점 수는 화면 폭에 묶인다.
 *
 * computeYRange/transform은 의존성 배열에 넣지 않는다 — 두 차트 모두 렌더마다 새 클로저를
 * 넘기지만 그 안에서 참조하는 값(toMm, SCALE_PADDING 등)은 모듈 상수라 클로저 정체성이
 * 바뀌어도 동작은 항상 같다. read()는 UPlotChart가 ref로만 호출하므로 최신 결과가 필요할
 * 때마다 다시 실행된다 — memo가 갱신되지 않아도 stale 값을 반환하지 않는다.
 */
export function useMetricChartSource(
  store: ChartStore,
  metric: ChartMetric,
  computeYRange: (snap: ChartSnapshot) => { yMin: number; yMax: number },
  transform?: (v: number) => number,
): UPlotDataSource {
  // 커밋 페이로드를 담을 버퍼 한 쌍 — 이 차트만 소유하고 매 커밋 재사용한다. 이 버퍼에
  // 쓰는 주체는 커밋 태스크뿐이라(스토어의 push/compact는 자기 내부 버퍼만 만진다) uPlot의
  // 자체 리드로우가 반쯤 갱신된 데이터를 그릴 창이 없다.
  const bufRef = useRef<SeriesReadBuffer | null>(null);

  return useMemo(() => ({
    subscribe: store.subscribe,
    read: (view) => {
      // count가 0이어도 빈 데이터를 그대로 커밋한다 — 세션 리셋 시 캔버스가 비워져야 한다.
      const snap = store.snapshot();
      const { yMin, yMax } = computeYRange(snap);
      const buf = (bufRef.current ??= createReadBuffer());

      const hasDomain = snap.firstX !== null && snap.lastX !== null && snap.lastX > snap.firstX;
      const xMin = view ? view.xMin : (snap.firstX ?? 0);
      const xMax = view && view.xMax > view.xMin ? view.xMax : (snap.lastX ?? 0);
      const columns = Math.max(1, Math.round(view?.pxWidth ?? SEED_PX_WIDTH));
      // 열마다 2점 + 선이 화면 경계에서 끊기지 않게 챙기는 양 끝점 2점.
      const count = store.readRange(metric, xMin, xMax, columns * 2 + 2, buf, transform);

      return {
        data: [buf.xs.subarray(0, count), buf.ys.subarray(0, count)] as unknown as uPlot.AlignedData,
        yRange: [yMin, yMax] as [number, number],
        // 뷰포트만 커밋하므로 "전체 도메인"은 데이터 extent가 아니다 — 이 값이 없으면
        // 줌 판정과 줌아웃 복원이 현재 창으로 수렴해 버린다.
        ...(hasDomain ? { xFull: [snap.firstX!, snap.lastX!] as [number, number] } : {}),
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [store, metric, transform]);
}
