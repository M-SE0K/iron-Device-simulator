// ─── 5단계 지연 측정 하네스 — 타입 정의 ─────────────────────────────────────
//
// 파이프라인 한 프레임이 지나는 다섯 구간을 각각 독립적으로 잰다(합산 ≠ E2E — 구간이
// 서로 겹치지 않는 순수 구간 시간이며, 렌더는 프레임 단위가 아니라 렌더 틱 단위다):
//
//   1. hwCaptureMs — HW capture. 마이크/CoreAudio가 오디오 버퍼 하나를 채워 캡처 콜백이
//      도착하기까지의 시간. 헬퍼/워클릿이 버퍼 시작 시각을 주지 않으므로 "직전 캡처 콜백과의
//      도착 간격"으로 근사한다(이론값 bufferSize/sampleRate 대비 지터·IPC 지연 확인용).
//      청크 1개가 와이어 프레임 여러 개로 쪼개지면 그 청크의 첫 프레임에만 기록(중복 집계 방지).
//   2. encodingMs — Encoding. 캡처 PCM → int16 와이어 프레임 패킹.
//      네이티브: 청크 도착(onData 진입) → 해당 와이어 프레임 완성(send 직전).
//      웹 폴백: encodeToInt16 실행 시간.
//   3. wasmMs — WASM 분석. ff_prot_start_exec 실행 시간(엔진이 frame 메시지에 실어 주는
//      processingMs — engine/utils.ts createAnalysisFrame에서 측정).
//   4. decodingMs — Decoding. frame 메시지 수신(onmessage 진입) → JSON 파싱 →
//      AnalysisFrame 구성 완료까지.
//   5. renderMs — ECharts 렌더. 차트 컴포넌트에 새 프레임이 커밋(useLayoutEffect)된
//      시점 → ECharts "rendered" 이벤트(캔버스 드로잉 완료)까지. 프레임이 아니라
//      렌더 틱(코얼레싱 후 setState) 단위, 차트별(temperature/excursion)로 기록.

/** 프레임 1개의 1~4단계 구간 시간 (ms) */
export interface PerfFrameSample {
  frameIdx: number;
  /** 오디오 타임라인 상 프레임 시각 (s) */
  audioTime: number;
  /** 1. HW capture — 직전 캡처 콜백과의 도착 간격. 첫 청크/청크 내 2번째 이후 프레임은 null. */
  hwCaptureMs: number | null;
  /** 2. Encoding — PCM → int16 와이어 프레임 패킹. */
  encodingMs: number | null;
  /** 3. WASM 분석 — ff_prot_start_exec (processingMs). */
  wasmMs: number;
  /** 4. Decoding — 수신 메시지 파싱 → AnalysisFrame 구성. */
  decodingMs: number;
}

/** 렌더 틱 1개의 5단계 구간 시간 (ms) — 차트별 */
export interface PerfRenderSample {
  chart: "temperature" | "excursion";
  /** 세션 시작 기준 상대 시각 (ms) */
  at: number;
  /** 5. ECharts 렌더 — 프레임 커밋 → rendered 이벤트. */
  renderMs: number;
}

/** 구간별 요약 통계 — 표본이 없으면 count=0, 나머지 null */
export interface PerfStageStats {
  count: number;
  avg: number | null;
  min: number | null;
  max: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/** 세션 파라미터 — 캡처 경로가 startSession에 넘긴다 */
export interface PerfSessionMeta {
  /** 캡처 경로 — native(CoreAudio 헬퍼) / web(getUserMedia+AudioWorklet) */
  mode: "native" | "web";
  sampleRate: number;
  samplesPerCh: number;
  channels: number;
  deviceName: string | null;
}

/** window.__ironPerf.export() / 러너(scripts/measure.ts)가 저장하는 JSON 스키마 */
export interface PerfExport {
  meta: PerfSessionMeta & {
    /** ISO 8601 세션 시작 시각 */
    startedAt: string;
    /** 세션 길이 (초) — endSession 전이면 현재까지 */
    durationSec: number;
    frameCount: number;
  };
  summary: {
    hwCapture: PerfStageStats;
    encoding: PerfStageStats;
    wasm: PerfStageStats;
    decoding: PerfStageStats;
    render: { temperature: PerfStageStats; excursion: PerfStageStats };
  };
  frames: PerfFrameSample[];
  renders: PerfRenderSample[];
}
