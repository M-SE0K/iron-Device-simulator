import type uPlot from "uplot";
import type { AnnotationPoint, AnnotationStore } from "./annotation-store";

// uPlot 플러그인 모음 — 휠 줌(+더블클릭 리셋 보정) / 툴팁 / 임계선 / 점 잇기 주석.
// 드래그 영역 선택 줌은 uPlot 내장 동작을 그대로 쓴다.

const WHEEL_ZOOM_FACTOR = 0.75;
// 휠로 거의 끝까지 줌 아웃하면 전체 범위에 스냅시켜 "줌 해제" 상태로 복귀시킨다.
const FULL_RANGE_SNAP = 0.995;

export interface ZoomPluginOptions {
  /**
   * 고정된 "전체(줌 아웃) 도메인"을 돌려주는 getter — 채널 파형/보호 감쇠 비교처럼 x축이
   * 항상 세션 전체 길이를 나타내야 하는 차트에서만 넘긴다. 생략하면(스트리밍 메인 차트)
   * 현재 로드된 데이터 자체의 min/max를 전체 범위로 쓴다.
   *
   * 값이 자주 바뀌는 세션 길이 같은 걸 넘길 때는 반드시 안정된(참조가 바뀌지 않는) 함수로
   * 감싸서 넘긴다 — 이 값이 곧 uPlot 옵션 객체(plugins 배열)에 박히므로, 매 렌더 새 함수를
   * 넘기면 uPlot 인스턴스가 매번 재생성된다.
   */
  getFullXRange?: () => [number, number] | null;
}

/** 전체(줌 아웃) x 범위 — getFullXRange가 있으면 그 값, 없으면 현재 로드된 데이터의 extent. */
function fullXRange(u: uPlot, getFullXRange?: () => [number, number] | null): [number, number] {
  const override = getFullXRange?.();
  if (override) return override;
  const xs = u.data[0];
  const dataMin = xs.length > 0 ? xs[0] : 0;
  const dataMax = xs.length > 0 ? xs[xs.length - 1] : 1;
  return [dataMin, dataMax];
}

/**
 * 커서 위치를 중심으로 x축을 휠 줌하고, 더블클릭 리셋을 getFullXRange 도메인에 맞게 보정한다.
 *
 * uPlot 기본 더블클릭 리셋(autoScaleX)은 항상 "현재 로드된 데이터"의 min/max로 돌아간다 —
 * getFullXRange가 없는 차트(스트리밍 메인 차트)는 그게 곧 원하는 전체 범위라 문제없지만,
 * getFullXRange가 있는 차트(예: 최근 30초만 로드된 채널 파형)는 로드된 구간이 아니라
 * "세션 전체"로 돌아가야 한다. uPlot 자체 dblclick 리스너가 먼저 등록되므로(내부 초기화가
 * 이 플러그인의 ready 훅보다 먼저 실행됨) 우리 리스너는 항상 그 뒤에 실행된다 — 네이티브
 * 리셋이 먼저 적용된 직후, 같은 동기 틱 안에서 실제 전체 범위로 다시 덮어써 화면 깜빡임 없이
 * 보정한다.
 */
export function zoomPlugin(opts: ZoomPluginOptions = {}): uPlot.Plugin {
  const { getFullXRange } = opts;

  return {
    hooks: {
      ready: (u) => {
        u.over.addEventListener(
          "wheel",
          (e) => {
            e.preventDefault();
            const rect = u.over.getBoundingClientRect();
            const left = e.clientX - rect.left;
            const leftPct = rect.width > 0 ? left / rect.width : 0.5;
            const xVal = u.posToVal(left, "x");

            const curMin = u.scales.x.min ?? 0;
            const curMax = u.scales.x.max ?? 1;
            const curRange = curMax - curMin;
            if (!(curRange > 0)) return;

            const [fullMin, fullMax] = fullXRange(u, getFullXRange);
            const fullRange = fullMax - fullMin;

            const nextRange = e.deltaY < 0 ? curRange * WHEEL_ZOOM_FACTOR : curRange / WHEEL_ZOOM_FACTOR;
            if (fullRange > 0 && nextRange >= fullRange * FULL_RANGE_SNAP) {
              u.setScale("x", { min: fullMin, max: fullMax });
              return;
            }

            let nextMin = xVal - leftPct * nextRange;
            let nextMax = nextMin + nextRange;
            if (nextMin < fullMin) { nextMin = fullMin; nextMax = fullMin + nextRange; }
            if (nextMax > fullMax) { nextMax = fullMax; nextMin = fullMax - nextRange; }
            u.setScale("x", { min: Math.max(fullMin, nextMin), max: Math.min(fullMax, nextMax) });
          },
          { passive: false },
        );

        if (getFullXRange) {
          u.over.addEventListener("dblclick", () => {
            const override = getFullXRange();
            if (!override) return;
            if (u.scales.x.min !== override[0] || u.scales.x.max !== override[1]) {
              u.setScale("x", { min: override[0], max: override[1] });
            }
          });
        }
      },
    },
  };
}

export interface TooltipOptions {
  unit: string;
  decimals: number;
  timeDecimals?: number;
}

/** 커서 추적 툴팁 — 다크 스타일 div 오버레이. */
export function tooltipPlugin(opts: TooltipOptions): uPlot.Plugin {
  const { unit, decimals, timeDecimals = 3 } = opts;
  let el: HTMLDivElement | null = null;

  return {
    hooks: {
      init: (u) => {
        el = document.createElement("div");
        Object.assign(el.style, {
          position: "absolute",
          zIndex: "10",
          pointerEvents: "none",
          display: "none",
          padding: "6px 8px",
          background: "#0F172A",
          border: "1px solid #1E293B",
          borderRadius: "4px",
          color: "#F1F5F9",
          fontSize: "11px",
          fontFamily: '"JetBrains Mono", monospace',
          whiteSpace: "nowrap",
        } satisfies Partial<CSSStyleDeclaration>);
        u.over.appendChild(el);
      },
      destroy: () => {
        el?.remove();
        el = null;
      },
      setCursor: (u) => {
        if (!el) return;
        const { idx, left, top } = u.cursor;
        if (idx == null || left == null || top == null || left < 0) {
          el.style.display = "none";
          return;
        }

        const t = u.data[0][idx];
        const lines: string[] = [];
        for (let i = 1; i < u.series.length; i++) {
          const series = u.series[i];
          if (!series.show) continue;
          const v = u.data[i][idx];
          if (v == null) continue;
          lines.push(`${series.label}: <b>${v.toFixed(decimals)}${unit ? ` ${unit}` : ""}</b>`);
        }
        if (lines.length === 0 || t === undefined) {
          el.style.display = "none";
          return;
        }

        el.innerHTML = `${t.toFixed(timeDecimals)}s<br/>${lines.join("<br/>")}`;
        el.style.display = "block";

        // 커서 우측에 띄우되, 플롯 오른쪽 경계를 넘으면 왼쪽으로 뒤집는다.
        const overWidth = u.over.getBoundingClientRect().width;
        const tipWidth = el.offsetWidth;
        const flip = left + 12 + tipWidth > overWidth;
        el.style.left = `${flip ? left - 12 - tipWidth : left + 12}px`;
        el.style.top = `${Math.max(0, top - 10)}px`;
      },
    },
  };
}

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

export interface ThresholdLine {
  y: number;
  color: string;
  label: string;
}

/** y=임계값(WARN/DANGER) 점선 + 라벨 — 캔버스에 직접 그린다. */
export function thresholdsPlugin(lines: ThresholdLine[]): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        if (lines.length === 0) return;
        const ctx = u.ctx;
        const pxRatio = window.devicePixelRatio || 1;
        const { left, width } = u.bbox;
        ctx.save();
        for (const line of lines) {
          const yMin = u.scales.y.min ?? -Infinity;
          const yMax = u.scales.y.max ?? Infinity;
          if (line.y < yMin || line.y > yMax) continue;
          const cy = Math.round(u.valToPos(line.y, "y", true));

          ctx.strokeStyle = line.color;
          ctx.lineWidth = pxRatio;
          ctx.setLineDash([4 * pxRatio, 4 * pxRatio]);
          ctx.beginPath();
          ctx.moveTo(left, cy);
          ctx.lineTo(left + width, cy);
          ctx.stroke();

          ctx.fillStyle = line.color;
          ctx.font = `${9 * pxRatio}px system-ui, sans-serif`;
          ctx.textAlign = "right";
          ctx.textBaseline = "bottom";
          ctx.fillText(line.label, left + width - 4 * pxRatio, cy - 2 * pxRatio);
        }
        ctx.restore();
      },
    },
  };
}
