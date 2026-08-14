import type uPlot from "uplot";
import { frameScheduler } from "@/shared/lib/frame-scheduler";
import { createReadBuffer, type SeriesReadBuffer } from "../read-buffer";
import type { ChannelWaveStore } from "../wave-store";

/** 인스턴스마다 다른 스케줄러 태스크 id를 붙이기 위한 카운터. */
let overlaySeq = 0;

export interface EnvelopeOverlayChannel {
  /** 이 채널의 파형 데이터를 들고 있는 독립 스토어 — u.data[]와 무관하게 자기 해상도로 자란다. */
  store: ChannelWaveStore;
  /** 범례 표시/색상/on-off 토글을 빌려올 시리즈 인덱스. u.data[seriesIdx]는 항상 비어있는
   * 플레이스홀더이며, 실제 그리기는 store.readRange()에서 직접 읽는다. */
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
 * u.data[]에 실데이터를 실어 u.setData()로 갱신하는 대신, 독립된 ChannelWaveStore를 직접 읽어
 * 캔버스에 수동으로 그리는 파형 오버레이 플러그인.
 *
 * 핵심은 **읽기가 뷰포트 단위**라는 것이다(store.readRange) — 지금 보이는 x 구간만, 화면 폭
 * 만큼의 점으로 읽는다. u.data에 세션 전체를 실으면 uPlot이 매 리드로우마다 그 전체를 훑어
 * 경로를 다시 만드는데(줌 한 스텝마다 재빌드), 그 비용이 세션 길이에 비례해 커진다. 여기서는
 * 버킷이 만석(5만 개)이 돼도 프레임당 처리 점 수가 화면 폭에 묶이고, 확대 상태에서는 보이지도
 * 않는 구간을 아예 순회하지 않는다.
 *
 * 라이브로 자라는 트레이스(보호 감쇠 결과)와 이미 전량이 확정된 정적 트레이스(업로드된 원본)를
 * 가리지 않는다 — 둘 다 같은 스토어 타입이고, 정적 트레이스는 그냥 스토어가 dirty해지지 않을
 * 뿐이다. 라이브 쪽은 스토어가 dirty해진 프레임에만 u.redraw(false, false)로 훅(drawAxes)을
 * 재실행한다 — 공식 시리즈 경로(setData/스케일 재계산)는 건너뛴다. 그 프레임 판정은 자체 rAF
 * 루프가 아니라 전역 frameScheduler에 맡긴다(차트마다 루프를 따로 돌리지 않기 위함).
 *
 * 줌/팬은 별도 배선이 필요 없다 — zoomPlugin이 u.setScale()을 부르면 uPlot이 스스로 다시
 * 그리며 drawAxes 훅도 함께 재실행되므로, 그 시점의 최신 스케일로 store를 다시 읽어
 * valToPos()하면 자동으로 따라간다.
 *
 * 점 마커도 여기서 그린다 — u.data[]가 비어 있어 uPlot의 기본 점 렌더가 쓸 데이터가 없다.
 * 표시 조건(점 간격이 촘촘하면 생략)은 uPlot이 기본 시리즈에 쓰는 기준과 맞춰 둬서,
 * Temperature/Excursion 차트와 확대했을 때 점이 나타나는 시점이 같다.
 */
export function envelopeOverlayPlugin(channels: readonly EnvelopeOverlayChannel[]): uPlot.Plugin {
  const taskId = `envelope-overlay:${++overlaySeq}`;
  let unregister: (() => void) | null = null;
  let dirty = true;
  let offs: Array<() => void> = [];
  // 채널을 하나씩 순서대로 그리고 그 자리에서 소비하므로 버퍼 한 쌍을 전 채널이 돌려 쓴다.
  // 프레임마다 배열을 새로 만들지 않는 것이 이 경로에서 할당을 0으로 유지하는 핵심이다.
  let scratch: SeriesReadBuffer | null = null;

  const strokeChannel = (u: uPlot, ctx: CanvasRenderingContext2D, ch: EnvelopeOverlayChannel): void => {
    const s = u.series[ch.seriesIdx];
    if (!s?.show) return;

    const pxRatio = window.devicePixelRatio || 1;
    const width = (s.width ?? 1) * pxRatio;
    if (!(width > 0)) return;

    const stroke = resolveStyle<CanvasRenderingContext2D["strokeStyle"]>(s.stroke, u, ch.seriesIdx);
    if (!stroke) return;

    const snap = ch.store.snapshot();
    if (snap.bucketCount === 0) return;

    const buf = (scratch ??= createReadBuffer());
    // bbox는 디바이스 픽셀이라 CSS 픽셀 열로 환산한다 — 열 하나당 min/max 2점이 예산이다.
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

      // 점 마커 — 메트릭 차트(Temperature/Excursion)와 같은 규약·같은 표시 조건이다.
      // u.data[]가 비어 있어 uPlot의 기본 점 렌더가 아무것도 그리지 못하므로 여기서 직접 그린다.
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
        // 배열 순서가 곧 z-order다 — 뒤에 오는 채널이 위에 그려진다.
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
