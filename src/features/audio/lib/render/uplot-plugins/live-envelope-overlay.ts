import type uPlot from "uplot";
import type { ChannelWaveStore } from "../wave-store";

export interface LiveEnvelopeChannel {
  /** 이 채널의 파형 데이터를 들고 있는 독립 스토어 — u.data[]와 무관하게 자기 해상도로 자란다. */
  store: ChannelWaveStore;
  /** 범례 표시/색상/on-off 토글을 빌려올 시리즈 인덱스. u.data[seriesIdx]는 항상 비어있는
   * 플레이스홀더이며, 실제 그리기는 store.readAligned()에서 직접 읽는다. */
  seriesIdx: number;
}

/**
 * Input(원본 PCM)처럼 u.data[]에 실데이터를 실어 u.setData()로 갱신하는 대신, 독립된
 * ChannelWaveStore를 직접 읽어 캔버스에 수동으로 그리는 라이브 오버레이 플러그인.
 *
 * u.setData()는 매번 uPlot 내부 스케일 재계산·시리즈 diff를 다시 돈다 — 정적인 원본 파형과
 * 같은 캔버스/인스턴스를 쓰면서도, 라이브로 계속 갱신되는 이 시리즈만 그 비용 없이 그리기
 * 위한 것이 이 플러그인의 존재 이유다. 스토어가 dirty해지면 자체 rAF 루프가 u.redraw(false,
 * false)만 불러 훅(drawAxes)을 재실행한다 — 공식 시리즈 경로(setData/스케일 재계산)는 건너뛴다.
 *
 * 줌/팬은 별도 배선이 필요 없다 — zoomPlugin이 u.setScale()을 부르면 uPlot이 스스로 다시
 * 그리며 drawAxes 훅도 함께 재실행되므로, 그 시점의 최신 스케일로 store 데이터를 다시
 * valToPos()하면 자동으로 따라간다.
 */
export function liveEnvelopeOverlayPlugin(channels: readonly LiveEnvelopeChannel[]): uPlot.Plugin {
  let raf = 0;
  let dirty = true;
  let offs: Array<() => void> = [];

  const strokeChannel = (u: uPlot, ctx: CanvasRenderingContext2D, ch: LiveEnvelopeChannel): void => {
    const s = u.series[ch.seriesIdx];
    if (!s?.show) return;

    const pxRatio = window.devicePixelRatio || 1;
    const width = (s.width ?? 1) * pxRatio;
    if (!(width > 0)) return;

    const stroke = typeof s.stroke === "function"
      ? (s.stroke as (self: uPlot, seriesIdx: number) => CanvasRenderingContext2D["strokeStyle"])(u, ch.seriesIdx)
      : (s.stroke as CanvasRenderingContext2D["strokeStyle"] | undefined);
    if (!stroke) return;

    if (ch.store.snapshot().bucketCount === 0) return;
    const [xs, ys] = ch.store.readAligned();
    if (xs.length === 0) return;

    ctx.save();

    const bounds = new Path2D();
    bounds.rect(
      u.bbox.left - width / 2,
      u.bbox.top - width / 2,
      u.bbox.width + width,
      u.bbox.height + width,
    );
    ctx.clip(bounds);

    const path = new Path2D();
    let started = false;
    for (let i = 0; i < xs.length; i++) {
      const px = u.valToPos(xs[i], "x", true);
      const py = u.valToPos(ys[i], "y", true);
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
    }

    ctx.restore();
  };

  return {
    hooks: {
      ready: (u) => {
        offs = channels.map((ch) => ch.store.subscribe(() => { dirty = true; }));
        const loop = () => {
          if (dirty) {
            dirty = false;
            u.redraw(false, false);
          }
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      },
      drawAxes: (u) => {
        const canvas = u.ctx.canvas;
        if (canvas.width === 0 || canvas.height === 0) return;
        for (const ch of channels) strokeChannel(u, u.ctx, ch);
      },
      destroy: () => {
        cancelAnimationFrame(raf);
        offs.forEach((off) => off());
        offs = [];
      },
    },
  };
}
