import type uPlot from "uplot";
import { formatTimeValue, timeDecimalsForScale } from "../uplot-option";

/**
 * u.data[]에 실데이터가 없는 시리즈(예: live-envelope-overlay.ts로 직접 캔버스에 그리는
 * 라이브 오버레이)를 툴팁에 포함시키기 위한 값 조회 훅. seriesIdx는 표시 여부(show)를
 * 빌려올 u.series 인덱스, resolve는 커서의 x값(초)을 받아 그 시각의 값을 돌려준다.
 */
export interface TooltipVirtualSeries {
  label: string;
  seriesIdx: number;
  resolve: (timeSec: number) => number | null;
}

export interface TooltipOptions {
  unit: string;
  decimals: number;
  virtualSeries?: TooltipVirtualSeries[];
}

/** 커서 추적 툴팁 — 다크 스타일 div 오버레이. */
export function tooltipPlugin(opts: TooltipOptions): uPlot.Plugin {
  const { unit, decimals, virtualSeries = [] } = opts;
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

        // 시각은 **커서 픽셀을 그대로 환산한 값**을 쓴다. 예전엔 u.data[0][idx]를 썼는데,
        // 그건 uPlot이 커서에서 가장 가까운 데이터 점으로 스냅한 시각이라 점 간격이 픽셀보다
        // 넓어지는 확대 상태에서 x축 눈금이 가리키는 시각과 눈에 띄게 어긋난다 — 파형
        // 엔벨로프는 점이 버킷 격자 위에만 있어(readRange가 버킷 시작/중앙 두 점을 낸다)
        // 특히 그렇다. 값은 스냅된 점에서 오지만(배열 인덱스로만 얻을 수 있다), "커서가
        // 가리키는 시각"은 축과 언제나 일치해야 한다. 축도 같은 포맷터를 쓰므로 눈금선 위에
        // 커서를 올리면 그 눈금의 라벨이 그대로 나온다.
        const t = u.posToVal(left, "x");
        if (!Number.isFinite(t)) {
          el.style.display = "none";
          return;
        }

        const lines: string[] = [];
        for (let i = 1; i < u.series.length; i++) {
          const series = u.series[i];
          if (!series.show) continue;
          const v = u.data[i][idx];
          if (v == null) continue;
          lines.push(`${series.label}: <b>${v.toFixed(decimals)}${unit ? ` ${unit}` : ""}</b>`);
        }
        // 가상 시리즈는 인덱스가 아니라 시각으로 조회하므로 커서 시각을 그대로 넘긴다 —
        // 스냅된 시각을 넘기던 예전보다 커서 위치에 더 정확히 대응한다.
        for (const vs of virtualSeries) {
          if (!u.series[vs.seriesIdx]?.show) continue;
          const v = vs.resolve(t);
          if (v == null) continue;
          lines.push(`${vs.label}: <b>${v.toFixed(decimals)}${unit ? ` ${unit}` : ""}</b>`);
        }
        if (lines.length === 0) {
          el.style.display = "none";
          return;
        }

        // 시간 라벨은 x축과 같은 자리수를 쓴다 — 확대해서 축이 소수 5자리를 보여주는데
        // 툴팁만 "1.000s"로 고정돼 있으면 커서가 가리키는 위치를 읽을 수 없다.
        el.innerHTML = `${formatTimeValue(t, timeDecimalsForScale(u))}<br/>${lines.join("<br/>")}`;
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
