import uPlotLib from "uplot";
import type uPlot from "uplot";

export function staticSeriesLayerPlugin(seriesIdx: readonly number[]): uPlot.Plugin {
  const buildPaths = uPlotLib.paths.linear!();

  let layer: HTMLCanvasElement | null = null;
  let layerCtx: CanvasRenderingContext2D | null = null;
  let cacheKey = "";

  const dataIds = new WeakMap<object, number>();
  let dataSeq = 0;
  const dataId = (col: unknown): number => {
    if (typeof col !== "object" || col === null) return -1;
    let id = dataIds.get(col);
    if (id === undefined) {
      id = ++dataSeq;
      dataIds.set(col, id);
    }
    return id;
  };

  const makeKey = (u: uPlot): string => {
    const canvas = u.ctx.canvas;
    const parts: (string | number)[] = [
      canvas.width, canvas.height,
      u.scales.x.min ?? "", u.scales.x.max ?? "",
      u.scales.y.min ?? "", u.scales.y.max ?? "",
    ];
    for (const i of seriesIdx) {
      parts.push(u.series[i]?.show ? 1 : 0, dataId(u.data[i]));
    }
    return parts.join("|");
  };

  const renderLayer = (u: uPlot, ctx: CanvasRenderingContext2D) => {
    const dataLen = u.data[0]?.length ?? 0;
    if (dataLen === 0) return;
    const pxRatio = window.devicePixelRatio || 1;

    for (const i of seriesIdx) {
      const s = u.series[i];
      if (!s?.show) continue;

      const width = (s.width ?? 1) * pxRatio;
      if (!(width > 0)) continue;

      const stroke = typeof s.stroke === "function"
        ? (s.stroke as (self: uPlot, seriesIdx: number) => CanvasRenderingContext2D["strokeStyle"])(u, i)
        : (s.stroke as CanvasRenderingContext2D["strokeStyle"] | undefined);
      if (!stroke) continue;

      const paths = buildPaths(u, i, 0, dataLen - 1);
      const path = paths?.stroke;
      if (!(path instanceof Path2D)) continue;

      ctx.save();

      const offset = (width % 2) / 2;
      if (s.pxAlign === 1 && offset > 0) ctx.translate(offset, offset);

      const bounds = new Path2D();
      bounds.rect(
        u.bbox.left - width / 2,
        u.bbox.top - width / 2,
        u.bbox.width + width,
        u.bbox.height + width,
      );
      ctx.clip(bounds);
      if (paths?.clip) ctx.clip(paths.clip);

      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.lineJoin = "round";
      ctx.lineCap = (s.cap as CanvasLineCap | undefined) ?? "butt";
      ctx.setLineDash(s.dash ?? []);
      ctx.stroke(path);

      ctx.restore();
    }
  };

  return {
    hooks: {
      drawAxes: (u) => {
        const canvas = u.ctx.canvas;
        if (canvas.width === 0 || canvas.height === 0) return;

        if (!layer) {
          layer = document.createElement("canvas");
          layerCtx = layer.getContext("2d");
        }
        if (!layerCtx) return;

        const nextKey = makeKey(u);
        if (nextKey !== cacheKey) {
          cacheKey = nextKey;
          if (layer.width !== canvas.width || layer.height !== canvas.height) {
            layer.width = canvas.width;
            layer.height = canvas.height;
          } else {
            layerCtx.clearRect(0, 0, layer.width, layer.height);
          }
          renderLayer(u, layerCtx);
        }

        u.ctx.drawImage(layer, 0, 0);
      },
      destroy: () => {
        layer = null;
        layerCtx = null;
        cacheKey = "";
      },
    },
  };
}
