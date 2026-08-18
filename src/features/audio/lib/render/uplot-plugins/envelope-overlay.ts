import "@/shared/lib/dpr-cap";
import uPlot from "uplot";
import { frameScheduler } from "@/shared/lib/frame-scheduler";
import { createReadBuffer, type SeriesReadBuffer } from "../read-buffer";
import type { ChannelWaveStore } from "../wave-store";

let overlaySeq = 0;

export interface EnvelopeOverlayChannel {
  store: ChannelWaveStore;
  seriesIdx: number;
}

function resolveStyle<T>(
  value: unknown,
  u: uPlot,
  seriesIdx: number,
): T | undefined {
  return typeof value === "function"
    ? (value as (self: uPlot, si: number) => T)(u, seriesIdx)
    : (value as T | undefined);
}

function shouldDrawPoints(u: uPlot, points: uPlot.Series.Points, count: number, pxRatio: number): boolean {
  if (count === 0) return false;
  const space = (points.space ?? 10) * pxRatio;
  if (!(space > 0)) return false;
  return count <= u.bbox.width / space;
}

export function envelopeOverlayPlugin(channels: readonly EnvelopeOverlayChannel[]): uPlot.Plugin {
  const taskId = `envelope-overlay:${++overlaySeq}`;
  let unregister: (() => void) | null = null;
  let dirty = true;
  let offs: Array<() => void> = [];
  let scratch: SeriesReadBuffer | null = null;

  const strokeChannel = (u: uPlot, ctx: CanvasRenderingContext2D, ch: EnvelopeOverlayChannel): void => {
    const s = u.series[ch.seriesIdx];
    if (!s?.show) return;

    const pxRatio = uPlot.pxRatio || 1;
    const width = (s.width ?? 1) * pxRatio;
    if (!(width > 0)) return;

    const stroke = resolveStyle<CanvasRenderingContext2D["strokeStyle"]>(s.stroke, u, ch.seriesIdx);
    if (!stroke) return;

    const snap = ch.store.snapshot();
    if (snap.bucketCount === 0) return;

    const buf = (scratch ??= createReadBuffer());
    const columns = Math.max(1, Math.round(u.bbox.width / pxRatio));
    const minSec = u.scales.x.min ?? 0;
    const maxSec = u.scales.x.max ?? snap.durationSec;
    const count = ch.store.readRange(minSec, maxSec, columns * 2, buf);
    if (count === 0) return;

    const points = s.points;
    const pointDiameter = points && points.show !== false && shouldDrawPoints(u, points, count, pxRatio)
      ? (points.size ?? 3 + (s.width ?? 1) * 2) * pxRatio
      : 0;

    ctx.save();

    const margin = Math.max(width, pointDiameter);
    const bounds = new Path2D();
    bounds.rect(
      u.bbox.left - margin / 2,
      u.bbox.top - margin / 2,
      u.bbox.width + margin,
      u.bbox.height + margin,
    );
    ctx.clip(bounds);

    const path = new Path2D();
    let started = false;
    for (let i = 0; i < count; i++) {
      const px = u.valToPos(buf.xs[i], "x", true);
      const py = u.valToPos(buf.ys[i], "y", true);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      if (!started) {
        path.moveTo(px, py);
        started = true;
      } else {
        path.lineTo(px, py);
      }
    }

    if (started) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.lineJoin = "round";
      ctx.lineCap = (s.cap as CanvasLineCap | undefined) ?? "butt";
      ctx.setLineDash(s.dash ?? []);
      ctx.stroke(path);
      ctx.setLineDash([]);

      if (pointDiameter > 0 && points) {
        const radius = pointDiameter / 2;
        const fill = resolveStyle<CanvasRenderingContext2D["fillStyle"]>(points.fill, u, ch.seriesIdx) ?? stroke;
        const dots = new Path2D();
        for (let i = 0; i < count; i++) {
          const px = u.valToPos(buf.xs[i], "x", true);
          const py = u.valToPos(buf.ys[i], "y", true);
          if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
          dots.moveTo(px + radius, py);
          dots.arc(px, py, radius, 0, Math.PI * 2);
        }
        ctx.fillStyle = fill;
        ctx.fill(dots);
      }
    }

    ctx.restore();
  };

  return {
    hooks: {
      ready: (u) => {
        offs = channels.map((ch) => ch.store.subscribe(() => { dirty = true; }));
        unregister = frameScheduler.register({
          id: taskId,
          phase: "draw",
          isDirty: () => dirty,
          run: () => {
            dirty = false;
            u.redraw(false, false);
          },
        });
      },
      drawAxes: (u) => {
        const canvas = u.ctx.canvas;
        if (canvas.width === 0 || canvas.height === 0) return;
        for (const ch of channels) strokeChannel(u, u.ctx, ch);
      },
      destroy: () => {
        unregister?.();
        unregister = null;
        offs.forEach((off) => off());
        offs = [];
        scratch = null;
      },
    },
  };
}
