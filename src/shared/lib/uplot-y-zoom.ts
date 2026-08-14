import type uPlot from "uplot";
import { createRectCache } from "@/shared/lib/element-rect";

/**
 * y축 gutter(플롯 영역 왼쪽 눈금 영역) 위에서의 확대/이동 조작.
 *
 * x축 줌(`lib/render/uplot-plugins/zoom.ts`)과 달리 uPlot 플러그인이 아니라 UPlotChart가
 * 직접 붙이는 헬퍼다. y 범위는 옵션의 `scales.y.range`가 아니라 UPlotChart가 소유한
 * yRange ref(소스/prop이 커밋마다 채우는 값)가 결정하므로, 사용자가 잡은 범위를 그 위에
 * 얹으려면 플러그인이 닿을 수 없는 그 ref를 만져야 하기 때문이다. 조작 → 범위 계산까지만
 * 여기서 하고, 실제 적용은 호출부가 넘긴 `apply`가 맡는다.
 *
 * uPlot의 축은 DOM 엘리먼트가 아니라 캔버스에 그려지므로 "y축 위"를 가려낼 타깃이 없다.
 * 대신 루트에서 이벤트를 받아 플롯 영역(`u.over`)의 왼쪽인지로 판정한다 — 플롯 영역
 * 안쪽은 이미 x축 줌/커서 드래그가 쓰고 있어 그대로 통과시킨다.
 *
 * 적용은 **프레임당 한 번으로 합쳐** 넘긴다. apply()는 동기 리드로우(setScale)인데 트랙패드
 * 휠은 초당 100회 넘게 들어오므로, 이벤트마다 즉시 적용하면 한 프레임 안에 리드로우가 여러 번
 * 쌓인다(화면에 남는 건 마지막 하나뿐이다). x축 줌(zoom.ts)과 같은 pending+rAF 방식이다.
 */

/** 휠 한 칸당 y 범위 배율 — x축(0.75)보다 완만하게 잡아 세밀한 조정이 되게 한다. */
const WHEEL_ZOOM_FACTOR = 0.85;
/** 자동 범위 근처까지 축소하면 잠금을 풀어 "자동 추종" 상태로 되돌린다. */
const AUTO_SNAP = 0.995;

export interface YZoomController {
  /**
   * 잠금이 없을 때 차트가 쓰는 자동 y 범위 — 축소하다 이 폭에 닿으면 잠금을 푼다.
   * 모르면(데이터 extent를 그대로 쓰는 차트) null을 돌려주면 되고, 그 경우 스냅 해제만
   * 동작하지 않는다(더블클릭으로는 여전히 풀 수 있다).
   */
  getAuto: () => [number, number] | null;
  /** 사용자 지정 y 범위를 적용한다. null이면 잠금을 풀고 자동 범위로 되돌린다. */
  apply: (range: [number, number] | null) => void;
}

export function attachYZoom(u: uPlot, ctrl: YZoomController): () => void {
  const root = u.root;

  // pointermove마다 rect를 직접 재면 강제 동기 레이아웃이 걸린다 — 특히 같은 이벤트에서
  // 툴팁(u.over의 mousemove)이 먼저 DOM을 건드리고 그 직후 이 리스너가 읽는 순서라 매번
  // 레이아웃이 동기로 돈다. 프레임당 한 번만 재는 캐시로 바꾼다(element-rect.ts).
  const overRect = createRectCache(u.over);

  /** 이벤트 지점이 y축 gutter(플롯 영역 왼쪽, 같은 세로 구간) 위인지. */
  const overAxis = (e: MouseEvent): boolean => {
    const r = overRect.get();
    return e.clientX < r.left && e.clientY >= r.top && e.clientY <= r.bottom;
  };

  // 아직 커밋되지 않은 목표 범위. undefined = 대기 없음, null = 잠금 해제(자동 복귀) 예약.
  let pending: [number, number] | null | undefined;
  let frame = 0;

  const flush = () => {
    frame = 0;
    const next = pending;
    pending = undefined;
    if (next !== undefined) ctrl.apply(next);
  };

  const schedule = (range: [number, number] | null) => {
    pending = range;
    if (frame === 0) frame = requestAnimationFrame(flush);
  };

  const cancelPending = () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    pending = undefined;
  };

  /** 지금 화면에 적용된(또는 이번 프레임에 적용될) y 범위 — 아직 폭이 잡히지 않았으면 null. */
  const currentRange = (): [number, number] | null => {
    // 같은 프레임의 앞선 이벤트가 잡아 둔 목표가 있으면 그쪽에서 이어 간다 — 커밋된 스케일
    // 기준으로 계산하면 한 프레임에 몰린 이벤트가 마지막 하나 빼고 전부 버려진다.
    if (pending !== undefined) return pending ?? ctrl.getAuto();
    const min = u.scales.y.min;
    const max = u.scales.y.max;
    return min != null && max != null && max > min ? [min, max] : null;
  };

  const onWheel = (e: WheelEvent) => {
    if (!overAxis(e)) return;
    e.preventDefault();

    const cur = currentRange();
    const rect = overRect.get();
    if (!cur || !(rect.height > 0)) return;

    // 커서가 가리키는 값을 제자리에 고정한 채 폭만 줄이고 늘린다(x축 휠 줌과 같은 감각).
    const topPct = (e.clientY - rect.top) / rect.height;
    const span = cur[1] - cur[0];
    const anchor = cur[1] - topPct * span;
    const nextSpan = e.deltaY < 0 ? span * WHEEL_ZOOM_FACTOR : span / WHEEL_ZOOM_FACTOR;

    const auto = ctrl.getAuto();
    const autoSpan = auto ? auto[1] - auto[0] : 0;
    if (autoSpan > 0 && nextSpan >= autoSpan * AUTO_SNAP) {
      schedule(null);
      return;
    }

    const nextMax = anchor + topPct * nextSpan;
    schedule([nextMax - nextSpan, nextMax]);
  };

  // 드래그 팬 — 축을 잡고 아래로 끌면 그래프도 함께 아래로 따라오도록(=보이는 값 구간이
  // 위로 이동) 부호를 잡는다. 시작 시점의 범위를 기준으로 누적 이동량을 계산하므로 중간에
  // 자동 범위가 갱신돼도 드래그가 튀지 않는다.
  let dragPointer = -1;
  let dragStartY = 0;
  let dragStartRange: [number, number] | null = null;
  // 커서 모양은 바뀔 때만 쓴다 — pointermove는 초당 수십 번 오므로 매번 style을 건드리면
  // 그때마다 스타일 재계산이 걸린다.
  let axisCursor = false;

  const setAxisCursor = (on: boolean) => {
    if (axisCursor === on) return;
    axisCursor = on;
    root.style.cursor = on ? "ns-resize" : "";
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || !overAxis(e)) return;
    const cur = currentRange();
    if (!cur) return;
    e.preventDefault();
    dragPointer = e.pointerId;
    dragStartY = e.clientY;
    dragStartRange = cur;
    root.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (dragStartRange === null || e.pointerId !== dragPointer) {
      // 드래그 중이 아닐 때는 커서 모양으로만 "여기는 잡을 수 있다"를 알린다.
      setAxisCursor(overAxis(e));
      return;
    }
    const rect = overRect.get();
    if (!(rect.height > 0)) return;
    const span = dragStartRange[1] - dragStartRange[0];
    const shift = ((e.clientY - dragStartY) / rect.height) * span;
    schedule([dragStartRange[0] + shift, dragStartRange[1] + shift]);
  };

  const endDrag = (e: PointerEvent) => {
    if (e.pointerId !== dragPointer) return;
    dragPointer = -1;
    dragStartRange = null;
    if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
  };

  const onLeave = () => {
    if (dragStartRange === null) setAxisCursor(false);
  };

  // 더블클릭은 축 위든 플롯 안이든 잠금을 푼다 — uPlot 자체 더블클릭이 x를 전체 범위로
  // 되돌리는 것과 짝을 맞춰, 한 번의 조작으로 두 축이 같이 원래대로 돌아가게 한다.
  // 리셋은 즉시 반영한다 — 대기 중인 휠/드래그 목표가 뒤늦게 덮어쓰지 않게 먼저 버린다.
  const onDblClick = () => {
    cancelPending();
    ctrl.apply(null);
  };

  root.addEventListener("wheel", onWheel, { passive: false });
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerup", endDrag);
  root.addEventListener("pointercancel", endDrag);
  root.addEventListener("pointerleave", onLeave);
  root.addEventListener("dblclick", onDblClick);

  return () => {
    root.removeEventListener("wheel", onWheel);
    root.removeEventListener("pointerdown", onPointerDown);
    root.removeEventListener("pointermove", onPointerMove);
    root.removeEventListener("pointerup", endDrag);
    root.removeEventListener("pointercancel", endDrag);
    root.removeEventListener("pointerleave", onLeave);
    root.removeEventListener("dblclick", onDblClick);
    cancelPending();
    overRect.dispose();
    setAxisCursor(false);
  };
}
