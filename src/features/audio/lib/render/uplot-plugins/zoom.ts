import type uPlot from "uplot";

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
 * getFullXRange가 있는 차트(현재는 보호 감쇠 비교)는 명시된 "세션 전체" 도메인으로
 * 돌아가야 한다. uPlot 자체 dblclick 리스너가 먼저 등록되므로(내부 초기화가
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
