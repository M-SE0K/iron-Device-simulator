// perf-e2e/collector.ts — N1~N12 E2E 지연 실험 수집기. 기본 비활성(최소 오버헤드): 각 기록 메서드는
// `active`가 아니면 즉시 반환하므로, 실험을 켜지 않은 일반 사용에는 성능 영향이 사실상 없다.
// 활성화: 브라우저 콘솔에서 window.__ironE2E.enable() 또는 URL에 ?e2e=1 (sessionStorage에 저장돼
// 새로고침 후에도 유지됨). docs/e2e-latency-experiment.md 참고.
import { downloadJsonArtifact, round3 } from "@/shared/lib/utils";
import {
  E2E_NODES,
  type E2ENodeId, type E2ESample, type E2EExport, type E2ESessionMeta,
} from "./types";
import { summarizeStats } from "../perf/statistics";

const STORAGE_KEY = "iron-e2e-latency";

function emptySamples(): Record<E2ENodeId, E2ESample[]> {
  const ids = Object.keys(E2E_NODES) as E2ENodeId[];
  const out = {} as Record<E2ENodeId, E2ESample[]>;
  for (const id of ids) out[id] = [];
  return out;
}

class E2ELatencyCollector {
  private enabled = false;
  private active = false;
  private meta: E2ESessionMeta | null = null;
  private startedAtIso = "";
  private samples: Record<E2ENodeId, E2ESample[]> = emptySamples();
  private commitAt = 0;

  constructor() {
    if (typeof window === "undefined") return;
    try {
      if (window.sessionStorage.getItem(STORAGE_KEY) === "1") this.enabled = true;
      const params = new URLSearchParams(window.location.search);
      if (params.get("e2e") === "1") {
        this.enabled = true;
        window.sessionStorage.setItem(STORAGE_KEY, "1");
      }
    } catch {
      // sessionStorage 접근 불가(프라이빗 모드 등) — 기본값(비활성) 유지
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  enable(): void {
    this.enabled = true;
    try { window.sessionStorage.setItem(STORAGE_KEY, "1"); } catch { /* noop */ }
    console.info("[iron-e2e] 활성화 — 다음에 시작하는 세션(재생/녹음)부터 N1~N12를 계측합니다.");
  }

  disable(): void {
    this.enabled = false;
    try { window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
  }

  isActive(): boolean {
    return this.active;
  }

  startSession(meta: E2ESessionMeta): void {
    if (!this.enabled) return;
    this.active = true;
    this.meta = meta;
    this.startedAtIso = new Date().toISOString();
    this.samples = emptySamples();
    this.commitAt = 0;
  }

  endSession(): void {
    this.active = false;
  }

  sample(node: E2ENodeId, ms: number, tag?: string): void {
    if (!this.active) return;
    this.samples[node].push(tag ? { ms: round3(ms), tag } : { ms: round3(ms) });
  }

  // 동기 함수를 감싸 실행 시간을 node에 기록한다. 비활성 시 계측 없이 fn()만 그대로 실행.
  time<T>(node: E2ENodeId, fn: () => T, tag?: string): T {
    if (!this.active) return fn();
    const t0 = performance.now();
    const out = fn();
    this.sample(node, performance.now() - t0, tag);
    return out;
  }

  // N11 기준 시각 저장용 — ChartStore.push/flush 직전에 호출한다. sampleSinceCommit은
  // useMetricChartRuntime.ts에서 N11 측정에 호출한다.
  markCommit(): void {
    if (!this.active) return;
    this.commitAt = performance.now();
  }

  sampleSinceCommit(node: E2ENodeId, tag?: string): void {
    if (!this.active || this.commitAt === 0) return;
    this.sample(node, performance.now() - this.commitAt, tag);
  }

  summary(): E2EExport["summary"] {
    const out = {} as E2EExport["summary"];
    for (const id of Object.keys(E2E_NODES) as E2ENodeId[]) {
      out[id] = { ...summarizeStats(this.samples[id].map((s) => s.ms)), label: E2E_NODES[id].label };
    }
    return out;
  }

  // 콘솔에서 바로 훑어보기 좋은 표 형태로 출력한다.
  report(): void {
    console.table(this.summary());
  }

  export(): E2EExport | null {
    if (!this.meta) return null;
    return {
      meta: { ...this.meta, startedAt: this.startedAtIso },
      nodes: E2E_NODES,
      summary: this.summary(),
      raw: this.samples,
    };
  }

  download(filename?: string): void {
    const data = this.export();
    if (!data) return;
    downloadJsonArtifact(data, "e2e-latency", data.meta, filename);
  }

  reset(): void {
    this.active = false;
    this.meta = null;
    this.samples = emptySamples();
    this.commitAt = 0;
  }
}

export const e2e = new E2ELatencyCollector();

declare global {
  interface Window {
    __ironE2E?: Pick<
      E2ELatencyCollector,
      "isEnabled" | "enable" | "disable" | "isActive" | "summary" | "report" | "export" | "download" | "reset"
    >;
  }
}
if (typeof window !== "undefined") {
  window.__ironE2E = e2e;
}
