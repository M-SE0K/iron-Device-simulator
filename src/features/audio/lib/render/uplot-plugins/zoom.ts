import type uPlot from "uplot";
import { createRectCache, type RectCache } from "@/shared/lib/element-rect";

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
  /**
   * 확대 하한(x 범위의 최소 폭). 생략하면 무한히 확대된다 — 원본 샘플까지 내려가는 채널
   * 파형은 화면에 샘플이 몇 개는 남도록 이 값을 준다(예: 16 / sampleRate).
   */
  minXRange?: number;
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
 *
 * 휠 이벤트는 **프레임당 한 번으로 합쳐** 반영한다. `u.setScale()`은 동기 리드로우이고, 그
 * 리드로우가 부르는 setScale 훅이 뷰포트 소스의 재읽기(다음 rAF의 setData = 두 번째 리드로우)
 * 까지 예약하므로, 이벤트마다 즉시 반영하면 초당 100회 넘게 들어오는 트랙패드 휠에서 한 프레임
 * 안에 전체 리드로우가 여러 번 쌓인다(화면에 보이는 건 결국 마지막 하나뿐이다). 목표 범위만
 * `pending`에 누적해 두고 rAF에서 한 번만 커밋한다 — 줌 배율은 이벤트 수만큼 그대로 누적되므로
 * 조작 감각은 바뀌지 않고, 그리기 횟수만 화면 주사율로 묶인다.
 */
export function zoomPlugin(opts: ZoomPluginOptions = {}): uPlot.Plugin {
  const { getFullXRange, minXRange } = opts;

  /** 아직 커밋되지 않은 목표 x 범위 — 같은 프레임의 다음 휠 이벤트는 이 값을 기준으로 계산한다. */
  let pending: [number, number] | null = null;
  let frame: number | null = null;
  // 휠 이벤트마다 rect를 직접 재면 강제 동기 레이아웃이 걸린다 — 프레임당 한 번만 잰다.
  let overRect: RectCache | null = null;

  const cancelPending = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    pending = null;
  };

  return {
    hooks: {
      ready: (u) => {
        overRect = createRectCache(u.over);

        const flush = () => {
          frame = null;
          const next = pending;
          pending = null;
          if (!next) return;
          // 그 사이 다른 경로(드래그 줌/더블클릭)가 이미 같은 범위로 맞춰 놨으면 그리지 않는다.
          if (u.scales.x.min === next[0] && u.scales.x.max === next[1]) return;
          u.setScale("x", { min: next[0], max: next[1] });
        };

        const schedule = (min: number, max: number) => {
          pending = [min, max];
          if (frame === null) frame = requestAnimationFrame(flush);
        };

        u.over.addEventListener(
          "wheel",
          (e) => {
            e.preventDefault();
            const rect = overRect!.get();
            const left = e.clientX - rect.left;
            const leftPct = rect.width > 0 ? left / rect.width : 0.5;

            // 기준은 화면에 적용된 스케일이 아니라 "이번 프레임에 적용될 범위"다 — 아직 커밋되지
            // 않은 목표가 있으면 그쪽에서 이어 확대해야 프레임 안의 이벤트가 하나도 안 버려진다.
            const curMin = pending ? pending[0] : (u.scales.x.min ?? 0);
            const curMax = pending ? pending[1] : (u.scales.x.max ?? 1);
            const curRange = curMax - curMin;
            if (!(curRange > 0)) return;
            // 커서가 가리키는 시각. u.posToVal은 커밋된 스케일로 환산하므로 pending이 있으면
            // 어긋난다 — 같은 선형 환산을 목표 범위 기준으로 직접 한다.
            const xVal = curMin + leftPct * curRange;

            const [fullMin, fullMax] = fullXRange(u, getFullXRange);
            const fullRange = fullMax - fullMin;

            let nextRange = e.deltaY < 0 ? curRange * WHEEL_ZOOM_FACTOR : curRange / WHEEL_ZOOM_FACTOR;
            if (minXRange != null && minXRange > 0 && nextRange < minXRange) {
              // 이미 하한이면 더 확대하지 않는다(같은 범위로 setScale하면 불필요한 리드로우만 난다).
              if (curRange <= minXRange) return;
              nextRange = minXRange;
            }
            if (fullRange > 0 && nextRange >= fullRange * FULL_RANGE_SNAP) {
              schedule(fullMin, fullMax);
              return;
            }

            let nextMin = xVal - leftPct * nextRange;
            let nextMax = nextMin + nextRange;
            if (nextMin < fullMin) { nextMin = fullMin; nextMax = fullMin + nextRange; }
            if (nextMax > fullMax) { nextMax = fullMax; nextMin = fullMax - nextRange; }
            schedule(Math.max(fullMin, nextMin), Math.min(fullMax, nextMax));
          },
          { passive: false },
        );

        if (getFullXRange) {
          u.over.addEventListener("dblclick", () => {
            // 리셋은 즉시 반영한다 — 대기 중인 휠 목표가 뒤늦게 덮어쓰지 않게 먼저 버린다.
            cancelPending();
            const override = getFullXRange();
            if (!override) return;
            if (u.scales.x.min !== override[0] || u.scales.x.max !== override[1]) {
              u.setScale("x", { min: override[0], max: override[1] });
            }
          });
        }
      },
      destroy: () => {
        cancelPending();
        overRect?.dispose();
        overRect = null;
      },
    },
  };
}
