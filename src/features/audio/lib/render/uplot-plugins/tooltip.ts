import type uPlot from "uplot";

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
