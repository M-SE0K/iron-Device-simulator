import { ironPerfCollector } from "./collector";

/* DevTools Performance 패널(Timings 레인)에서 스테이지 구간을 막대로 보기 위한
 * User Timing 방출. 측정은 이미 끝난 뒤 duration만 받으므로 [now-ms, now] 구간을
 * 소급 기록한다 — wasm_engine처럼 워커에서 측정된 스테이지는 메인 스레드 도착
 * 시점 기준으로 약간 밀려 표시되지만 막대 폭(소요 시간)은 정확하다. */
const MEASURE_PREFIX = "iron:";

/* measure 엔트리는 clearMeasures 전까지 Performance 버퍼에 계속 쌓인다(wasm_engine은
 * ~100회/s). DevTools 녹화에는 measure() 호출 시점에 트레이스 이벤트가 남으므로,
 * 버퍼를 주기적으로 비워도 녹화본에서는 사라지지 않는다. */
const MEASURE_TRIM_INTERVAL = 1000;

let measuredNames: Set<string> | null = null;
let measureCount = 0;

function emitTimingMeasure(stage: string, ms: number): void {
  if (typeof performance === "undefined" || typeof performance.measure !== "function") return;
  const name = `${MEASURE_PREFIX}${stage}`;
  const end = performance.now();
  try {
    performance.measure(name, { start: Math.max(0, end - ms), end });
  } catch {
    return; // options 형태 미지원 등 — collector 집계는 그대로 계속된다
  }
  const names = (measuredNames ??= new Set());
  names.add(name);
  if (++measureCount % MEASURE_TRIM_INTERVAL === 0) {
    names.forEach((n) => performance.clearMeasures(n));
  }
}

/** 계측 빌드 여부 — recordPerfSample 은 스스로 가드하지만, 스탬프 배열 유지 같은
 * 계측 "준비" 비용까지 피하고 싶은 호출부가 이 값으로 감싼다. */
export function isIronPerfEnabled(): boolean {
  return process.env.NEXT_PUBLIC_IRON_PERF === "1";
}

export function recordPerfSample(stage: string, ms: number): void {
  if (process.env.NEXT_PUBLIC_IRON_PERF !== "1") return;
  emitTimingMeasure(stage, ms);
  ironPerfCollector.record(stage, ms);
}

/* ── 엔벌로프 경로 A/B 토글 (측정 빌드 전용) ─────────────────────────────────
 * 같은 빌드 안에서 집계 경로를 바꿔가며 동일 계측으로 전/후를 비교하기 위한 장치.
 *   "wasm"   — pcm-kit WASM 커널 (기본)
 *   "js"     — 커널을 쓰지 않고 신 JS 폴백 강제 (pcm-kit.ts)
 *   "legacy" — pcm-kit 도입 전 per-sample floor 구현 (wave-store.ts 의 레거시 경로)
 * 콘솔에서 __ironPerf.envelopeMode("legacy") 로 전환(localStorage 영속) 후 시나리오를
 * 다시 트리거하면 된다. envelope_* 스테이지 이름에 "_legacy"/"_js" 접미사가 붙어
 * 한 스냅숏/녹화 안에서 모드별 수치가 나란히 보인다. */
export type EnvelopeMode = "wasm" | "js" | "legacy";

const ENVELOPE_MODE_KEY = "iron-perf.envelope-mode";

let envelopeMode: EnvelopeMode | null = null;

function loadEnvelopeMode(): EnvelopeMode {
  if (typeof window === "undefined") return "wasm";
  try {
    const v = window.localStorage.getItem(ENVELOPE_MODE_KEY);
    if (v === "js" || v === "legacy") return v;
  } catch {
    /* localStorage 접근 불가 환경 — 기본값 유지 */
  }
  return "wasm";
}

export function getEnvelopeMode(): EnvelopeMode {
  if (process.env.NEXT_PUBLIC_IRON_PERF !== "1") return "wasm";
  return (envelopeMode ??= loadEnvelopeMode());
}

export function setEnvelopeMode(mode: EnvelopeMode): EnvelopeMode {
  if (mode !== "wasm" && mode !== "js" && mode !== "legacy") {
    console.warn(`[iron-perf] 알 수 없는 envelope mode: ${String(mode)} (wasm | js | legacy)`);
    return getEnvelopeMode();
  }
  envelopeMode = mode;
  try {
    window.localStorage.setItem(ENVELOPE_MODE_KEY, mode);
  } catch {
    /* 영속 실패해도 이번 세션에는 적용됨 */
  }
  console.info(
    `[iron-perf] envelope mode = ${mode} — 파일 재업로드/뷰 토글로 시나리오를 다시 트리거하세요. ` +
    `이후 계측은 envelope_*${mode === "wasm" ? "" : `_${mode}`} 스테이지로 기록됩니다.`,
  );
  return mode;
}

/** envelope_* 스테이지 이름에 붙일 현재 모드 접미사 ("" | "_js" | "_legacy"). */
export function envelopeModeSuffix(): string {
  const mode = getEnvelopeMode();
  return mode === "wasm" ? "" : `_${mode}`;
}

let initialized = false;

export function initIronPerf(): void {
  if (process.env.NEXT_PUBLIC_IRON_PERF !== "1" || typeof window === "undefined") return;
  if (initialized) return;
  initialized = true;

  (window as unknown as { __ironPerf: unknown }).__ironPerf = {
    snapshot: () => ironPerfCollector.snapshot(),
    reset: () => ironPerfCollector.reset(),
    subscribe: (fn: (stage: string, ms: number) => void) => ironPerfCollector.subscribe(fn),
    envelopeMode: (mode?: EnvelopeMode) =>
      mode === undefined ? getEnvelopeMode() : setEnvelopeMode(mode),
  };
}
