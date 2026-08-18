const CHART_MAX_DPR = 1.5;

const INSTALL_FLAG = "__ironChartDprCap";

if (typeof window !== "undefined" && !(INSTALL_FLAG in window)) {
  (window as unknown as Record<string, unknown>)[INSTALL_FLAG] = true;

  const desc =
    Object.getOwnPropertyDescriptor(window, "devicePixelRatio")
    ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window) as object, "devicePixelRatio");
  const initial = window.devicePixelRatio || 1;
  const readReal = desc?.get
    ? () => (desc.get as (this: Window) => number).call(window)
    : () => initial;

  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    enumerable: true,
    get: () => Math.min(readReal(), CHART_MAX_DPR),
  });
}
