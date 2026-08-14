import type uPlot from "uplot";
import { formatTimeValue, timeDecimalsForScale, valueDecimalsForScale } from "../uplot-option";

/**
 * 값을 u.data 인덱스 스냅 대신 **시각으로 직접 조회**하는 시리즈. 두 경우에 쓴다 —
 * (1) u.data[]에 실데이터가 없는 시리즈(예: envelope-overlay.ts로 직접 캔버스에 그리는
 * 파형 오버레이), (2) u.data가 뷰포트 감량 커밋본(픽셀 열당 min/max 극점)이라 인덱스
 * 스냅이 커서가 가리키는 선과 어긋나는 시리즈(메트릭 차트). seriesIdx는 표시 여부(show)를
 * 빌려올 u.series 인덱스이고, 같은 인덱스의 실 시리즈 기본 조회는 이쪽이 대체한다.
 * resolve는 커서의 x값(초)을 받아 그 시각의 값을 돌려준다.
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
  // 이 인덱스들의 실 시리즈 기본 조회(u.data 스냅)는 건너뛴다 — 가상 시리즈가 대체한다.
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

        // ⚠️ 이 읽기는 **아래 쓰기들보다 먼저** 와야 한다. innerHTML을 바꾼 뒤에 offsetWidth를
        // 읽으면 브라우저가 그 변경의 레이아웃을 그 자리에서 계산하게 되고(강제 동기 레이아웃),
        // 그게 마우스를 움직이는 내내 매 이벤트 반복된다. 여기서 얻는 값은 **직전 내용**의
        // 폭이지만, 툴팁은 고정폭 글꼴에 줄 수도 일정해 한 이벤트 낡은 폭으로 뒤집기를
        // 판정해도 결과가 달라지지 않는다.
        let tipWidth = el.offsetWidth;

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

        // 자리수는 y축 눈금과 같은 규칙(줌 폭 적응)을 하한으로 공유한다 — y줌으로 축이
        // 자리수를 늘렸는데 툴팁만 고정 자리수면 같은 값이 서로 다르게 찍혀 어긋나 보인다.
        // 고정값은 "기본 배율에서 보장할 최소 정밀도"로만 남는다.
        const valueDecimals = Math.max(decimals, valueDecimalsForScale(u));

        const lines: string[] = [];
        for (let i = 1; i < u.series.length; i++) {
          const series = u.series[i];
          if (!series.show || virtualIdx.has(i)) continue;
          const v = u.data[i][idx];
          if (v == null) continue;
          lines.push(`${series.label}: <b>${v.toFixed(valueDecimals)}${unit ? ` ${unit}` : ""}</b>`);
        }
        // 가상 시리즈는 인덱스가 아니라 시각으로 조회하므로 커서 시각을 그대로 넘긴다 —
        // 스냅된 시각을 넘기던 예전보다 커서 위치에 더 정확히 대응한다.
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

        // 시간 라벨은 x축과 같은 자리수를 쓴다 — 확대해서 축이 소수 5자리를 보여주는데
        // 툴팁만 "1.000s"로 고정돼 있으면 커서가 가리키는 위치를 읽을 수 없다.
        el.innerHTML = `${formatTimeValue(t, timeDecimalsForScale(u))}<br/>${lines.join("<br/>")}`;
        el.style.display = "block";
        // 숨겨져 있다 처음 나타나는 순간에만 잴 폭이 없다(display:none이면 offsetWidth가 0) —
        // 그 한 번은 여기서 실측한다. 이후 이동에서는 위에서 미리 읽어 둔 값을 쓴다.
        if (tipWidth === 0) tipWidth = el.offsetWidth;

        // 커서 우측에 띄우되, 플롯 오른쪽 경계를 넘으면 왼쪽으로 뒤집는다. 플롯 폭은 uPlot이
        // 이미 들고 있어(bbox는 디바이스 픽셀) getBoundingClientRect로 다시 잴 이유가 없다.
        const overWidth = u.bbox.width / (window.devicePixelRatio || 1);
        const flip = left + 12 + tipWidth > overWidth;
        el.style.left = `${flip ? left - 12 - tipWidth : left + 12}px`;
        el.style.top = `${Math.max(0, top - 10)}px`;
      },
    },
  };
}
