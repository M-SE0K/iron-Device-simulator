import type uPlot from "uplot";
import { createRectCache, type RectCache } from "@/shared/lib/element-rect";

const WHEEL_ZOOM_FACTOR = 0.75;
const FULL_RANGE_SNAP = 0.995;

export interface ZoomPluginOptions {
  getFullXRange?: () => [number, number] | null;
  minXRange?: number;
}

function fullXRange(u: uPlot, getFullXRange?: () => [number, number] | null): [number, number] {
  const override = getFullXRange?.();
  if (override) return override;
  const xs = u.data[0];
  const dataMin = xs.length > 0 ? xs[0] : 0;
  const dataMax = xs.length > 0 ? xs[xs.length - 1] : 1;
  return [dataMin, dataMax];
}

export function zoomPlugin(opts: ZoomPluginOptions = {}): uPlot.Plugin {
  const { getFullXRange, minXRange } = opts;

  let pending: [number, number] | null = null;
  let frame: number | null = null;
  let overRect: RectCache | null = null;

  const cancelPending = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    pending = null;
  };

  return {
    hooks: {
      ready: (u) => {
        overRect = createRectCache(u.over);

        const flush = () => {
          frame = null;
          const next = pending;
          pending = null;
          if (!next) return;
          if (u.scales.x.min === next[0] && u.scales.x.max === next[1]) return;
          u.setScale("x", { min: next[0], max: next[1] });
        };

        const schedule = (min: number, max: number) => {
          pending = [min, max];
          if (frame === null) frame = requestAnimationFrame(flush);
        };

        u.over.addEventListener(
          "wheel",
          (e) => {
            e.preventDefault();
            const rect = overRect!.get();
            const left = e.clientX - rect.left;
            const leftPct = rect.width > 0 ? left / rect.width : 0.5;

            const curMin = pending ? pending[0] : (u.scales.x.min ?? 0);
            const curMax = pending ? pending[1] : (u.scales.x.max ?? 1);
            const curRange = curMax - curMin;
            if (!(curRange > 0)) return;
            const xVal = curMin + leftPct * curRange;

            const [fullMin, fullMax] = fullXRange(u, getFullXRange);
            const fullRange = fullMax - fullMin;

            let nextRange = e.deltaY < 0 ? curRange * WHEEL_ZOOM_FACTOR : curRange / WHEEL_ZOOM_FACTOR;
            if (minXRange != null && minXRange > 0 && nextRange < minXRange) {
              if (curRange <= minXRange) return;
              nextRange = minXRange;
            }
            if (fullRange > 0 && nextRange >= fullRange * FULL_RANGE_SNAP) {
              schedule(fullMin, fullMax);
              return;
            }

            let nextMin = xVal - leftPct * nextRange;
            let nextMax = nextMin + nextRange;
            if (nextMin < fullMin) { nextMin = fullMin; nextMax = fullMin + nextRange; }
            if (nextMax > fullMax) { nextMax = fullMax; nextMin = fullMax - nextRange; }
            schedule(Math.max(fullMin, nextMin), Math.min(fullMax, nextMax));
          },
          { passive: false },
        );

        if (getFullXRange) {
          u.over.addEventListener("dblclick", () => {
            cancelPending();
            const override = getFullXRange();
            if (!override) return;
            if (u.scales.x.min !== override[0] || u.scales.x.max !== override[1]) {
              u.setScale("x", { min: override[0], max: override[1] });
            }
          });
        }
      },
      destroy: () => {
        cancelPending();
        overRect?.dispose();
        overRect = null;
      },
    },
  };
}
