import "@/shared/lib/dpr-cap";
import uPlot from "uplot";
import type { AnnotationPoint, AnnotationStore } from "../annotation-store";

export interface AnnotatePluginOptions {
  store: AnnotationStore;
  isEnabled: () => boolean;
  color?: string;
}

const CLICK_MOVE_TOLERANCE_PX = 4;

export function annotatePlugin(opts: AnnotatePluginOptions): uPlot.Plugin {
  const { store, isEnabled, color = "#F43F5E" } = opts;

  let downPos: { x: number; y: number } | null = null;
  let previewRaf: number | null = null;
  let unsubscribe: (() => void) | null = null;
  let onKeyDown: ((e: KeyboardEvent) => void) | null = null;

  const snapPoint = (u: uPlot): AnnotationPoint | null => {
    const idx = u.cursor.idx;
    if (idx == null) return null;
    const x = u.data[0][idx];
    if (x === undefined) return null;
    for (let i = 1; i < u.series.length; i++) {
      if (u.series[i].show === false) continue;
      const y = u.data[i][idx];
      if (y != null) return { x, y };
    }
    return null;
  };

  const toCanvasX = (u: uPlot, cssLeft: number) => u.bbox.left + cssLeft * (uPlot.pxRatio || 1);
  const toCanvasY = (u: uPlot, cssTop: number) => u.bbox.top + cssTop * (uPlot.pxRatio || 1);

  const drawPoint = (ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) => {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  };

  return {
    hooks: {
      ready: (u) => {
        unsubscribe = store.subscribe(() => u.redraw(false));

        u.over.addEventListener("mousedown", (e) => {
          downPos = { x: e.clientX, y: e.clientY };
        });

        u.over.addEventListener("click", (e) => {
          if (!isEnabled()) return;
          if (
            downPos
            && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_MOVE_TOLERANCE_PX
          ) return;
          const point = snapPoint(u);
          if (!point) return;
          const draft = store.getDraft();
          if (!draft) {
            store.setDraft(point);
            return;
          }
          if (draft.x === point.x && draft.y === point.y) {
            store.setDraft(null);
            return;
          }
          store.addSegment({ a: draft, b: point });
          store.setDraft(null);
        });

        onKeyDown = (e: KeyboardEvent) => {
          if (e.key !== "Escape") return;
          if (!isEnabled() || !store.getDraft()) return;
          store.setDraft(null);
        };
        document.addEventListener("keydown", onKeyDown);
      },
      setCursor: (u) => {
        const enabled = isEnabled();
        const cursorStyle = enabled ? "crosshair" : "";
        if (u.over.style.cursor !== cursorStyle) u.over.style.cursor = cursorStyle;
        if (!enabled || !store.getDraft()) return;
        if (previewRaf !== null) return;
        previewRaf = requestAnimationFrame(() => {
          previewRaf = null;
          u.redraw(false);
        });
      },
      draw: (u) => {
        const segments = store.getSegments();
        const draft = isEnabled() ? store.getDraft() : null;
        if (segments.length === 0 && !draft) return;

        const ctx = u.ctx;
        const pxRatio = uPlot.pxRatio || 1;
        const { left, top, width, height } = u.bbox;
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, top, width, height);
        ctx.clip();

        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1.5 * pxRatio;

        for (const seg of segments) {
          const ax = Math.round(u.valToPos(seg.a.x, "x", true));
          const ay = Math.round(u.valToPos(seg.a.y, "y", true));
          const bx = Math.round(u.valToPos(seg.b.x, "x", true));
          const by = Math.round(u.valToPos(seg.b.y, "y", true));
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
          drawPoint(ctx, ax, ay, 3 * pxRatio);
          drawPoint(ctx, bx, by, 3 * pxRatio);
        }

        if (draft) {
          const dx = Math.round(u.valToPos(draft.x, "x", true));
          const dy = Math.round(u.valToPos(draft.y, "y", true));
          drawPoint(ctx, dx, dy, 3.5 * pxRatio);
          const { left: cssLeft, top: cssTop } = u.cursor;
          if (cssLeft != null && cssTop != null && cssLeft >= 0 && cssTop >= 0) {
            ctx.setLineDash([5 * pxRatio, 4 * pxRatio]);
            ctx.beginPath();
            ctx.moveTo(dx, dy);
            ctx.lineTo(toCanvasX(u, cssLeft), toCanvasY(u, cssTop));
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }

        ctx.restore();
      },
      destroy: (u) => {
        unsubscribe?.();
        unsubscribe = null;
        if (onKeyDown) document.removeEventListener("keydown", onKeyDown);
        onKeyDown = null;
        if (previewRaf !== null) cancelAnimationFrame(previewRaf);
        previewRaf = null;
        u.over.style.cursor = "";
      },
    },
  };
}
