// ─── 5단계 지연 측정 하네스 — 수집기(싱글턴) ────────────────────────────────
//
// 계측 지점이 4개 레이어(캡처 훅 / 세션 훅 / 엔진 메시지 / 차트)에 흩어져 있어 prop/ref
// 드릴링 대신 모듈 싱글턴 하나(perf)를 각 지점이 직접 import한다. 세션 생명주기는
// useCaptureSession이 소유한다(캡처 시작 → startSession, cleanup → endSession).
//
//   useNativeCapture / useWebAudioWorkletCapture
//     → markChunkArrival()          : 캡처 콜백 진입(1. HW capture 간격의 기준점)
//     → markFrameSent(encodingMs)   : 와이어 프레임 send 직전(2. Encoding 확정,
//                                     1·2단계 값을 프레임 순서 그대로 FIFO에 페어링)
//   useCaptureSession(onmessage "frame")
//     → recordFrame(audioTime, wasmMs, decodingMs) : 3·4단계 + FIFO에서 1·2단계 회수
//   TemperatureChart / ExcursionChart (perfTrack 인스턴스만 — 상세 오버레이 중복 방지)
//     → recordRender(chart, renderMs) : 5. ECharts 렌더
//
// 측정 데이터는 세션이 끝나도 다음 세션 시작 전까지 보존된다 — 콘솔/러너가
// window.__ironPerf.summary()/export()/download()로 꺼내 간다.
import type {
  PerfExport, PerfFrameSample, PerfRenderSample, PerfSessionMeta, PerfStageStats,
} from "./types";

const round3 = (v: number) => parseFloat(v.toFixed(3));

function stageStats(values: number[]): PerfStageStats {
  if (values.length === 0) {
    return { count: 0, avg: null, min: null, max: null, p50: null, p95: null, p99: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    avg: round3(sum / sorted.length),
    min: round3(sorted[0]),
    max: round3(sorted[sorted.length - 1]),
    p50: round3(pct(50)),
    p95: round3(pct(95)),
    p99: round3(pct(99)),
  };
}

class PerfCollector {
  private active = false;
  private meta: PerfSessionMeta | null = null;
  private startedAtIso = "";
  private startedAtPerf = 0;
  private endedAtPerf: number | null = null;
  private frames: PerfFrameSample[] = [];
  private renders: PerfRenderSample[] = [];
  private frameIdx = 0;
  // 1단계 — 직전 캡처 콜백 도착 시각. 간격은 markFrameSent 시점에 청크당 1회만 소비된다.
  private lastChunkAt = 0;
  private pendingHwCaptureMs: number | null = null;
  // 1·2단계 → 3·4단계 페어링 FIFO — send는 캡처 스레드 콜백에서, frame 수신은 마이크로태스크
  // 에서 일어나 한 청크가 여러 프레임을 연속 send할 수 있으므로 단일 슬롯 대신 큐로 잇는다.
  private sentQueue: Array<{ hwCaptureMs: number | null; encodingMs: number | null }> = [];

  /** 새 캡처 세션 시작 — 이전 세션 데이터를 버리고 수집을 켠다(캡처 훅이 호출). */
  startSession(meta: PerfSessionMeta): void {
    this.active = true;
    this.meta = meta;
    this.startedAtIso = new Date().toISOString();
    this.startedAtPerf = performance.now();
    this.endedAtPerf = null;
    this.frames = [];
    this.renders = [];
    this.frameIdx = 0;
    this.lastChunkAt = 0;
    this.pendingHwCaptureMs = null;
    this.sentQueue = [];
  }

  /** 세션 종료 — 수집만 멈추고 데이터는 다음 startSession까지 보존한다(cleanup이 호출). */
  endSession(): void {
    if (!this.active) return;
    this.active = false;
    this.endedAtPerf = performance.now();
  }

  isActive(): boolean {
    return this.active;
  }

  /** 1. HW capture — 캡처 콜백(네이티브 onData / 워클릿 message) 진입 시 호출. */
  markChunkArrival(): void {
    if (!this.active) return;
    const now = performance.now();
    if (this.lastChunkAt > 0) this.pendingHwCaptureMs = round3(now - this.lastChunkAt);
    this.lastChunkAt = now;
  }

  /** 2. Encoding — 와이어 프레임 send 직전 호출. 1단계 간격과 함께 프레임 순서로 페어링. */
  markFrameSent(encodingMs: number | null): void {
    if (!this.active) return;
    this.sentQueue.push({
      hwCaptureMs: this.pendingHwCaptureMs,
      encodingMs: encodingMs !== null ? round3(encodingMs) : null,
    });
    this.pendingHwCaptureMs = null; // 같은 청크의 2번째 이후 프레임엔 싣지 않는다
  }

  /** 3·4. WASM 분석 + Decoding — frame 메시지 처리 완료 시 호출(useCaptureSession). */
  recordFrame(audioTime: number, wasmMs: number, decodingMs: number): void {
    if (!this.active) return;
    const sent = this.sentQueue.shift() ?? { hwCaptureMs: null, encodingMs: null };
    this.frames.push({
      frameIdx: this.frameIdx++,
      audioTime,
      hwCaptureMs: sent.hwCaptureMs,
      encodingMs: sent.encodingMs,
      wasmMs: round3(wasmMs),
      decodingMs: round3(decodingMs),
    });
  }

  /** 5. ECharts 렌더 — 차트가 프레임 커밋→rendered 구간을 잰 뒤 호출(perfTrack 인스턴스만). */
  recordRender(chart: PerfRenderSample["chart"], renderMs: number): void {
    if (!this.active) return;
    this.renders.push({
      chart,
      at: round3(performance.now() - this.startedAtPerf),
      renderMs: round3(renderMs),
    });
  }

  frameCount(): number {
    return this.frames.length;
  }

  summary(): PerfExport["summary"] {
    const pick = (sel: (f: PerfFrameSample) => number | null) =>
      this.frames.map(sel).filter((v): v is number => v !== null);
    const renderOf = (chart: PerfRenderSample["chart"]) =>
      this.renders.filter((r) => r.chart === chart).map((r) => r.renderMs);
    return {
      hwCapture: stageStats(pick((f) => f.hwCaptureMs)),
      encoding: stageStats(pick((f) => f.encodingMs)),
      wasm: stageStats(pick((f) => f.wasmMs)),
      decoding: stageStats(pick((f) => f.decodingMs)),
      render: {
        temperature: stageStats(renderOf("temperature")),
        excursion: stageStats(renderOf("excursion")),
      },
    };
  }

  /** 세션 전체 스냅샷 — 세션이 한 번도 시작되지 않았으면 null. */
  export(): PerfExport | null {
    if (!this.meta) return null;
    const endPerf = this.endedAtPerf ?? performance.now();
    return {
      meta: {
        ...this.meta,
        startedAt: this.startedAtIso,
        durationSec: round3((endPerf - this.startedAtPerf) / 1000),
        frameCount: this.frames.length,
      },
      summary: this.summary(),
      frames: this.frames,
      renders: this.renders,
    };
  }

  /** export()를 JSON 파일로 다운로드(브라우저 콘솔용 편의 함수). */
  download(filename?: string): void {
    const data = this.export();
    if (!data || typeof document === "undefined") return;
    const stamp = data.meta.startedAt.replace(/[:.]/g, "-");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename ?? `perf_${data.meta.mode}_${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  reset(): void {
    this.active = false;
    this.meta = null;
    this.frames = [];
    this.renders = [];
    this.frameIdx = 0;
    this.lastChunkAt = 0;
    this.pendingHwCaptureMs = null;
    this.sentQueue = [];
  }
}

export const perf = new PerfCollector();

// ── 콘솔/자동화 러너(scripts/measure.ts) 접근용 전역 노출 ────────────────────
declare global {
  interface Window {
    __ironPerf?: Pick<
      PerfCollector,
      "isActive" | "frameCount" | "summary" | "export" | "download" | "reset"
    >;
  }
}
if (typeof window !== "undefined") {
  window.__ironPerf = perf;
}
