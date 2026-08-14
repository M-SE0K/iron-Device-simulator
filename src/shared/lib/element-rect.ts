/**
 * 엘리먼트의 화면 좌표(`getBoundingClientRect`)를 **프레임당 한 번만** 재는 캐시.
 *
 * pointermove/wheel 핸들러에서 rect를 직접 재면 강제 동기 레이아웃(forced reflow)이 걸린다.
 * 그 자체로도 싸지 않지만, 같은 이벤트의 앞선 리스너가 DOM을 건드렸다면(예: 툴팁이
 * innerHTML과 위치를 바꾼 직후 y축 게터 히트테스트가 rect를 읽는다) 브라우저가 그 변경의
 * 스타일·레이아웃을 그 자리에서 전부 계산한 뒤에야 값을 돌려준다 — 포인터를 움직이는 내내
 * 프레임마다 레이아웃이 동기로 두세 번씩 도는 layout thrashing이 된다.
 *
 * 영구 캐시로는 못 바꾼다 — 스크롤·리사이즈·레이아웃 변경으로 rect가 바뀌고, 그 전부를
 * 구독하는 건 rect를 다시 재는 것보다 비싸다. 대신 rAF로 프레임 경계마다 버린다. 이 캐시를
 * 쓰는 곳(축 게터 히트테스트, 휠 줌 앵커)은 대상이 수십 px 넓이라 최대 한 프레임(≈16 ms)
 * 낡은 값으로 판정해도 결과가 달라지지 않는다.
 */
export interface RectCache {
  /** 이번 프레임의 rect — 처음 호출에서만 실제로 재고, 다음 프레임까지 같은 값을 돌려준다. */
  get: () => DOMRect;
  /** 예약된 무효화 rAF를 취소한다 — 리스너를 떼는 시점에 함께 호출한다. */
  dispose: () => void;
}

export function createRectCache(el: Element): RectCache {
  let cached: DOMRect | null = null;
  let raf = 0;

  return {
    get: () => {
      if (cached === null) {
        cached = el.getBoundingClientRect();
        if (raf === 0) {
          raf = requestAnimationFrame(() => {
            raf = 0;
            cached = null;
          });
        }
      }
      return cached;
    },
    dispose: () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      raf = 0;
      cached = null;
    },
  };
}
