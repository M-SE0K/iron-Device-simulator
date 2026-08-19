import "@/shared/lib/dpr-cap";
import uPlot from "uplot";
import { formatTimeValue, timeDecimalsForScale, valueDecimalsForScale } from "../uplot-option";

/* 현재 플롯 뷰포트 — 엔벌로프처럼 "픽셀 컬럼 단위로 집계해서 그리는" 시리즈가 그려진
 * 것과 같은 컬럼을 다시 찾아갈 수 있도록 넘긴다(ChannelWaveStore.pointAt 참고). */
export interface TooltipView {
  xMin: number;
  xMax: number;
  columns: number;
}

/** 캔버스에 실제로 찍힌 꼭짓점. 툴팁은 이 값을 표시하고 그 자리에 마커를 찍는다. */
export interface TooltipPoint {
  timeSec: number;
  value: number;
}

interface TooltipVirtualSeries {
  label: string;
  seriesIdx: number;
  /* 그려진 점을 돌려주면(TooltipPoint) 그 좌표에 마커가 붙는다 — 툴팁 숫자와 캔버스 위
   * 위치가 항상 같은 점을 가리키도록. 좌표가 없는 시리즈는 숫자만 돌려주면 된다. */
  resolve: (timeSec: number, view: TooltipView) => number | TooltipPoint | null;
}

export interface TooltipOptions {
  unit: string;
  decimals: number;
  virtualSeries?: TooltipVirtualSeries[];
}

function seriesStroke(u: uPlot, seriesIdx: number): string {
  const stroke = u.series[seriesIdx]?.stroke;
  const resolved = typeof stroke === "function"
    ? (stroke as (self: uPlot, si: number) => unknown)(u, seriesIdx)
    : stroke;
  return typeof resolved === "string" ? resolved : "#F1F5F9";
}

export function tooltipPlugin(opts: TooltipOptions): uPlot.Plugin {
  const { unit, decimals, virtualSeries = [] } = opts;
  const virtualIdx = new Set(virtualSeries.map((vs) => vs.seriesIdx));
  let el: HTMLDivElement | null = null;
  let markers: HTMLDivElement[] = [];

  const hideAll = () => {
    if (el) el.style.display = "none";
    for (const m of markers) m.style.display = "none";
  };

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

        /* 가상 시리즈는 uPlot 이 커서 포인트를 찍어주지 못한다(커밋된 데이터가 없어서).
         * 같은 역할의 마커를 직접 둔다 — 캔버스 재그리기 없이 DOM 으로만 움직인다. */
        markers = virtualSeries.map(() => {
          const m = document.createElement("div");
          Object.assign(m.style, {
            position: "absolute",
            zIndex: "9",
            pointerEvents: "none",
            display: "none",
            width: "9px",
            height: "9px",
            marginLeft: "-4.5px",
            marginTop: "-4.5px",
            borderRadius: "50%",
            border: "2px solid #FFFFFF",
            boxSizing: "border-box",
          } satisfies Partial<CSSStyleDeclaration>);
          u.over.appendChild(m);
          return m;
        });
      },
      destroy: () => {
        el?.remove();
        el = null;
        for (const m of markers) m.remove();
        markers = [];
      },
      setCursor: (u) => {
        if (!el) return;
        const { idx, left, top } = u.cursor;
        if (idx == null || left == null || top == null || left < 0) {
          hideAll();
          return;
        }

        let tipWidth = el.offsetWidth;

        const t = u.posToVal(left, "x");
        if (!Number.isFinite(t)) {
          hideAll();
          return;
        }

        const valueDecimals = Math.max(decimals, valueDecimalsForScale(u));
        const suffix = unit ? ` ${unit}` : "";
        const fmt = (v: number) => v.toFixed(valueDecimals);

        const pxRatio = uPlot.pxRatio || 1;
        const overWidth = u.bbox.width / pxRatio;
        const overHeight = u.bbox.height / pxRatio;

        /* envelopeOverlayPlugin 이 readRange 를 부를 때 쓰는 것과 같은 뷰포트/컬럼 수. */
        const view: TooltipView = {
          xMin: u.scales.x.min ?? 0,
          xMax: u.scales.x.max ?? 0,
          columns: Math.max(1, Math.round(overWidth)),
        };

        const lines: string[] = [];
        for (let i = 1; i < u.series.length; i++) {
          const series = u.series[i];
          if (!series.show || virtualIdx.has(i)) continue;
          const v = u.data[i][idx];
          if (v == null || !Number.isFinite(v)) continue;
          lines.push(`${series.label}: <b>${fmt(v)}${suffix}</b>`);
        }

        virtualSeries.forEach((vs, mi) => {
          const marker = markers[mi];
          if (marker) marker.style.display = "none";
          if (!u.series[vs.seriesIdx]?.show) return;

          const resolved = vs.resolve(t, view);
          if (resolved == null) return;

          const value = typeof resolved === "number" ? resolved : resolved.value;

          if (typeof resolved !== "number" && marker) {
            const mx = u.valToPos(resolved.timeSec, "x");
            const my = u.valToPos(value, "y");
            /* 현재 y 범위 밖(줌으로 잘린 구간)이면 마커만 안 찍는다 — 숫자는 그대로 보여준다. */
            if (my >= 0 && my <= overHeight && mx >= 0 && mx <= overWidth) {
              marker.style.background = seriesStroke(u, vs.seriesIdx);
              marker.style.left = `${mx}px`;
              marker.style.top = `${my}px`;
              marker.style.display = "block";
            }
          }

          lines.push(`${vs.label}: <b>${fmt(value)}${suffix}</b>`);
        });

        if (lines.length === 0) {
          hideAll();
          return;
        }

        el.innerHTML = `${formatTimeValue(t, timeDecimalsForScale(u))}<br/>${lines.join("<br/>")}`;
        el.style.display = "block";
        if (tipWidth === 0) tipWidth = el.offsetWidth;

        const flip = left + 12 + tipWidth > overWidth;
        el.style.left = `${flip ? left - 12 - tipWidth : left + 12}px`;
        el.style.top = `${Math.max(0, top - 10)}px`;
      },
    },
  };
}
