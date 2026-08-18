export interface RectCache {
  get: () => DOMRect;
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
