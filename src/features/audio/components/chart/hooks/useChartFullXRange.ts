import { useCallback } from "react";
import type { ChartStore } from "@/features/audio/lib/render/chart-store";

/**
 * 메인 차트의 "전체(줌 아웃) x 도메인" getter — `zoomPlugin`에 넘긴다.
 *
 * 뷰포트만 커밋하게 된 뒤로는 `u.data[0]`의 extent가 곧 **지금 확대해 놓은 창**이라서,
 * zoomPlugin의 기본값(데이터 extent)을 그대로 두면 휠 줌아웃이 현재 창으로 스냅해 아무
 * 변화가 없고 더블클릭 리셋도 같은 창으로 돌아온다. 세션 전체를 명시해야 한다.
 *
 * 돌려주는 값은 `useMetricChartSource`가 `xFull`로 알려주는 값과 **반드시 같아야** 한다 —
 * UPlotChart의 줌 여부 판정(`isZoomed`)이 그 `xFull`을 기준으로 하므로, 둘이 어긋나면
 * 줌아웃해도 계속 "줌 중"으로 남아 스트리밍 추종이 되살아나지 않는다.
 *
 * 반환 참조는 store가 같은 한 고정된다 — 이 값이 uPlot 옵션 객체(plugins 배열)에 박히므로
 * 매 렌더 새 함수를 넘기면 인스턴스가 통째로 재생성된다.
 */
export function useChartFullXRange(store: ChartStore): () => [number, number] | null {
  return useCallback(() => {
    const { firstX, lastX } = store.snapshot();
    if (firstX === null || lastX === null || !(lastX > firstX)) return null;
    return [firstX, lastX];
  }, [store]);
}
