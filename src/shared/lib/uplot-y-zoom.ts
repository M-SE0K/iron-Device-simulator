import type uPlot from "uplot";
import { createRectCache } from "@/shared/lib/element-rect";

const WHEEL_ZOOM_FACTOR = 0.85;
const AUTO_SNAP = 0.995;

export interface YZoomController {
  getAuto: () => [number, number] | null;
  apply: (range: [number, number] | null) => void;
}

export function attachYZoom(u: uPlot, ctrl: YZoomController): () => void {
  const root = u.root;

  const overRect = createRectCache(u.over);

  const overAxis = (e: MouseEvent): boolean => {
    const r = overRect.get();
    return e.clientX < r.left && e.clientY >= r.top && e.clientY <= r.bottom;
  };

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

  const currentRange = (): [number, number] | null => {
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

  let dragPointer = -1;
  let dragStartY = 0;
  let dragStartRange: [number, number] | null = null;
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
