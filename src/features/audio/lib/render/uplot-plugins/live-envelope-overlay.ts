import type uPlot from "uplot";
import type { ChannelWaveStore } from "../wave-store";

export interface LiveEnvelopeChannel {
  /** 이 채널의 파형 데이터를 들고 있는 독립 스토어 — u.data[]와 무관하게 자기 해상도로 자란다. */
  store: ChannelWaveStore;
  /** 범례 표시/색상/on-off 토글을 빌려올 시리즈 인덱스. u.data[seriesIdx]는 항상 비어있는
   * 플레이스홀더이며, 실제 그리기는 store.readAligned()에서 세션 전체를 직접 읽는다. */
  seriesIdx: number;
}

/** uPlot 시리즈의 stroke/fill 필드는 값일 수도, (self, seriesIdx) => 값인 함수일 수도 있다. */
function resolveStyle<T>(
  value: unknown,
  u: uPlot,
  seriesIdx: number,
): T | undefined {
  return typeof value === "function"
    ? (value as (self: uPlot, si: number) => T)(u, seriesIdx)
    : (value as T | undefined);
}

/**
 * 점을 그릴지 판정 — uPlot이 기본 시리즈에 쓰는 기준과 같다. 점 사이 평균 간격이
 * `space`(기본 10 CSS px)보다 촘촘해지면 점이 뭉쳐 선만 굵어 보이므로 그리지 않는다.
 * Temperature/Excursion 차트에서 확대할 때만 점이 나타나는 것도 같은 규칙이다.
 */
function shouldDrawPoints(u: uPlot, points: uPlot.Series.Points, count: number, pxRatio: number): boolean {
  if (count === 0) return false;
  const space = (points.space ?? 10) * pxRatio;
  if (!(space > 0)) return false;
  return count <= u.bbox.width / space;
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
 * 읽기는 store.readAligned()로 세션 전체 min/max 엔벨로프를 정확한 길이의 새 배열 두 개로
 * 가져온다. 그중 현재 x 스케일 밖의 점은 아래 캔버스 클립 영역에서 보이지 않게 된다.
 *
 * 줌/팬은 별도 배선이 필요 없다 — zoomPlugin이 u.setScale()을 부르면 uPlot이 스스로 다시
 * 그리며 drawAxes 훅도 함께 재실행되므로, 그 시점의 최신 스케일로 store를 다시 읽어
 * valToPos()하면 자동으로 따라간다.
 *
 * 점 마커도 여기서 그린다 — u.data[]가 비어 있어 uPlot의 기본 점 렌더가 쓸 데이터가 없다.
 * 표시 조건(점 간격이 촘촘하면 생략)은 uPlot이 기본 시리즈에 쓰는 기준과 맞춰 둬서,
 * Temperature/Excursion 차트와 확대했을 때 점이 나타나는 시점이 같다.
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

    const stroke = resolveStyle<CanvasRenderingContext2D["strokeStyle"]>(s.stroke, u, ch.seriesIdx);
    if (!stroke) return;

    const snap = ch.store.snapshot();
    if (snap.bucketCount === 0) return;

    const [xs, ys] = ch.store.readAligned();
    const count = xs.length;
    if (count === 0) return;

    const points = s.points;
    const pointDiameter = points && points.show !== false && shouldDrawPoints(u, points, count, pxRatio)
      ? (points.size ?? 3 + (s.width ?? 1) * 2) * pxRatio
      : 0;

    ctx.save();

    // 클립 여백은 선 두께와 점 지름 중 큰 쪽 — 좁게 잡으면 플롯 가장자리에 걸친 점이 반쯤 잘린다.
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
      ctx.setLineDash([]);

      // 점 마커 — 메트릭 차트(Temperature/Excursion)와 같은 규약·같은 표시 조건이다.
      // u.data[]가 비어 있어 uPlot의 기본 점 렌더가 아무것도 그리지 못하므로 여기서 직접 그린다.
      if (pointDiameter > 0 && points) {
        const radius = pointDiameter / 2;
        const fill = resolveStyle<CanvasRenderingContext2D["fillStyle"]>(points.fill, u, ch.seriesIdx) ?? stroke;
        const dots = new Path2D();
        for (let i = 0; i < count; i++) {
          const px = u.valToPos(xs[i], "x", true);
          const py = u.valToPos(ys[i], "y", true);
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
