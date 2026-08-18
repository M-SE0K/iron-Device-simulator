import "@/shared/lib/dpr-cap";
import uPlot from "uplot";
import { formatTimeValue, timeDecimalsForScale, valueDecimalsForScale } from "../uplot-option";

interface TooltipVirtualSeries {
  label: string;
  seriesIdx: number;
  resolve: (timeSec: number) => number | null;
}

export interface TooltipOptions {
  unit: string;
  decimals: number;
  virtualSeries?: TooltipVirtualSeries[];
}

export function tooltipPlugin(opts: TooltipOptions): uPlot.Plugin {
  const { unit, decimals, virtualSeries = [] } = opts;
  const virtualIdx = new Set(virtualSeries.map((vs) => vs.seriesIdx));
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

        let tipWidth = el.offsetWidth;

        const t = u.posToVal(left, "x");
        if (!Number.isFinite(t)) {
          el.style.display = "none";
          return;
        }

        const valueDecimals = Math.max(decimals, valueDecimalsForScale(u));

        const lines: string[] = [];
        for (let i = 1; i < u.series.length; i++) {
          const series = u.series[i];
          if (!series.show || virtualIdx.has(i)) continue;
          const v = u.data[i][idx];
          if (v == null) continue;
          lines.push(`${series.label}: <b>${v.toFixed(valueDecimals)}${unit ? ` ${unit}` : ""}</b>`);
        }
        for (const vs of virtualSeries) {
          if (!u.series[vs.seriesIdx]?.show) continue;
          const v = vs.resolve(t);
          if (v == null) continue;
          lines.push(`${vs.label}: <b>${v.toFixed(valueDecimals)}${unit ? ` ${unit}` : ""}</b>`);
        }
        if (lines.length === 0) {
          el.style.display = "none";
          return;
        }

        el.innerHTML = `${formatTimeValue(t, timeDecimalsForScale(u))}<br/>${lines.join("<br/>")}`;
        el.style.display = "block";
        if (tipWidth === 0) tipWidth = el.offsetWidth;

        const overWidth = u.bbox.width / (uPlot.pxRatio || 1);
        const flip = left + 12 + tipWidth > overWidth;
        el.style.left = `${flip ? left - 12 - tipWidth : left + 12}px`;
        el.style.top = `${Math.max(0, top - 10)}px`;
      },
    },
  };
}
