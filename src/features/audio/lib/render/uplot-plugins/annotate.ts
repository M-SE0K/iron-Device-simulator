import type uPlot from "uplot";
import type { AnnotationPoint, AnnotationStore } from "../annotation-store";

export interface AnnotatePluginOptions {
  /** 선분/드래프트의 소유자 — 차트 컴포넌트 바깥(대시보드)에서 세션 단위로 관리된다. */
  store: AnnotationStore;
  /**
   * 그리기 모드 여부 getter — 상태가 아니라 ref를 읽는 안정된 함수로 넘긴다. 이 값이 곧
   * uPlot 옵션(plugins 배열)에 박히므로, 토글마다 함수가 새로 만들어지면 인스턴스가
   * 재생성돼 줌 상태를 잃는다.
   */
  isEnabled: () => boolean;
  /** 선/점 색상 — 기본은 rose 계열(시리즈 색과 겹치지 않게). */
  color?: string;
}

/** 클릭 판정 허용 이동량(px) — 이보다 크면 드래그(영역 줌)로 보고 무시한다. */
const CLICK_MOVE_TOLERANCE_PX = 4;

/**
 * 점 잇기 주석 — 그리기 모드(isEnabled)에서 클릭 → 클릭으로 두 데이터 포인트를 직선으로
 * 잇는다. 클릭은 커서의 최근접 데이터 인덱스(u.cursor.idx)에 스냅되므로 항상 실제 데이터
 * 포인트끼리 연결된다. 첫 클릭 뒤에는 커서를 따라 미리보기 점선이 그려지고, 같은 점을 다시
 * 클릭하거나 ESC를 누르면 취소된다. 확정된 선분은 데이터 좌표로 저장돼 그리기 모드를 꺼도,
 * 줌/리사이즈를 해도 그대로 유지된다 — 지우기는 스토어 clear()(카드 헤더의 지우개 버튼).
 *
 * 기존 조작과의 공존: 드래그(영역 줌)·더블클릭(줌 리셋)은 그대로 동작한다 — mousedown과
 * click 사이의 이동량으로 클릭/드래그를 가른다.
 */
export function annotatePlugin(opts: AnnotatePluginOptions): uPlot.Plugin {
  const { store, isEnabled, color = "#F43F5E" } = opts;

  let downPos: { x: number; y: number } | null = null;
  let previewRaf: number | null = null;
  let unsubscribe: (() => void) | null = null;
  let onKeyDown: ((e: KeyboardEvent) => void) | null = null;

  /** 커서의 최근접 데이터 인덱스에서 첫 번째 보이는 시리즈의 값을 뽑아 스냅 점을 만든다. */
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

  const toCanvasX = (u: uPlot, cssLeft: number) => u.bbox.left + cssLeft * (window.devicePixelRatio || 1);
  const toCanvasY = (u: uPlot, cssTop: number) => u.bbox.top + cssTop * (window.devicePixelRatio || 1);

  const drawPoint = (ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) => {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  };

  return {
    hooks: {
      ready: (u) => {
        // 스토어 변경(선 추가/취소/지우기) 즉시 다시 그린다 — 경로 재계산은 불필요하다.
        unsubscribe = store.subscribe(() => u.redraw(false));

        u.over.addEventListener("mousedown", (e) => {
          downPos = { x: e.clientX, y: e.clientY };
        });

        u.over.addEventListener("click", (e) => {
          if (!isEnabled()) return;
          // mousedown에서 이만큼 움직였으면 드래그 영역 줌이다 — 점 선택으로 오인하지 않는다.
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
          // 같은 점을 다시 클릭하면 선택 취소로 처리한다.
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
        // 그리기 모드 표시 — 커서만으로도 모드에 있음을 알 수 있게 한다.
        const enabled = isEnabled();
        const cursorStyle = enabled ? "crosshair" : "";
        if (u.over.style.cursor !== cursorStyle) u.over.style.cursor = cursorStyle;
        // 첫 점이 찍힌 동안 커서를 따라오는 미리보기 — rAF로 합쳐 이동 이벤트 빈도와
        // 무관하게 화면 주사율로만 다시 그린다(정지 상태 전용 기능이라 부담이 없다).
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
        const pxRatio = window.devicePixelRatio || 1;
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
