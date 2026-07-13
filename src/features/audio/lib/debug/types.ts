// ─── 스트리밍 디버그 정보 ────────────────────────────────────────────────────

/** 프레임 단위 디버그 로그 엔트리 */
export interface DebugLogEntry {
  /** 브라우저 기준 수신 절대 시각 (ms) */
  receivedAt:        number;
  /** 오디오 타임라인 상 프레임 시각 (s) */
  audioTime:         number;
  frameIdx:          number;
  /** 클라이언트 왕복 지연 (ms) — send→recv */
  rttMs:             number | null;
  /** WASM 엔진 처리 시간 (ms) */
  serverProcMs:      number;
  temperature:       number;
  excursion:         number;
  /** recv → React useLayoutEffect (직전 렌더 사이클 값) */
  reactRenderMs:     number | null;
  /** React useLayoutEffect → ECharts rendered 이벤트 */
  echartsRenderMs:   number | null;
  /** recv → ECharts rendered (react + echarts 합산) */
  totalRecvRenderMs: number | null;
  /** 최신성 지연 — (currentAudioTime - latestRenderedFrame.time) × 1000 */
  freshnessLagMs:    number | null;
}

// ─── 측정 세션 JSON 내보내기 ─────────────────────────────────────────────────

export interface MeasurementExport {
  meta: {
    /** ISO 8601 기록 시각 */
    recordedAt: string;
    /** 분석 대상 오디오 파일명 */
    audioFile: string | null;
    /** 측정 구간 길이 (초) */
    measurementDurationSec: number;
    /** 수집된 총 프레임 수 */
    frameCount: number;
  };
  summary: {
    rtt:            { avg: number | null; min: number | null; max: number | null; p50: number | null; p95: number | null; p99: number | null };
    serverProc:     { avg: number | null };
    recvRender:     { avg: number | null; min: number | null; max: number | null; p50: number | null; p95: number | null; p99: number | null };
    /** RTT + recv→render 합산 End-to-End */
    e2e:            { avg: number | null; min: number | null; max: number | null; p50: number | null; p95: number | null; p99: number | null };
    /** 수신 시점 기준 freshness lag (per received frame, dropped 포함) */
    freshnessLag:   { avg: number | null; min: number | null; max: number | null; p50: number | null; p95: number | null; p99: number | null };
    /** 렌더 완료 시점 기준 freshness lag (per render tick, 실제 사용자 체감값) */
    renderFreshnessLag: { avg: number | null; min: number | null; max: number | null; p50: number | null; p95: number | null; p99: number | null };
    temperature:    { avg: number;        min: number;        max: number        };
    excursion:      { avg: number;        min: number;        max: number        };
    /** 측정 구간 중 streamingFrames 최대 길이 */
    maxStreamingFramesLen: number;
    /** 총 수신 프레임 대비 드롭 비율 */
    droppedFrameRatio: number | null;
    /** 총 드롭된 프레임 수 */
    totalDroppedFrames: number;
    /** 렌더 틱당 평균 소스 프레임 수 */
    avgSourceCount: number | null;
    /** Step 6: 보존된 이벤트 프레임 수 */
    preservedEvents: number;
    /** Step 6: 이벤트 프레임 목록 (audioTime, eventType) */
    eventLog: { audioTime: number; eventType: "temp_warn" | "temp_danger" | "exc_peak" }[];
  };
  frames: DebugLogEntry[];
  /** 정책 적용 전 수신된 모든 raw 프레임 (충실도 MAE 계산용 기준값) */
  rawFrames: { time: number; temperature: [number, number]; excursion: [number, number] }[];
  /** 실제 화면에 렌더링된 프레임 시퀀스 (코얼레싱 정책 적용 후) */
  renderedFrames: { time: number; temperature: [number, number]; excursion: [number, number] }[];
}

export interface StreamDebugInfo {
  wsConnected:        boolean;
  framesSent:         number;
  framesReceived:     number;
  /** 마지막 프레임 왕복 지연 (send→recv 지연, ms) */
  latestRttMs:        number | null;
  /** 최근 100프레임 평균 RTT (ms) */
  avgRttMs:           number | null;
  minRttMs:           number | null;
  maxRttMs:           number | null;
  /** 서버 측 ff_prot 처리 시간 (ms) */
  serverProcessingMs: number | null;
  /** rAF 루프 프레임 전송 속도 (frames/s) */
  sendRateFps:        number | null;
  /** recv → React useLayoutEffect */
  reactRenderMs:      number | null;
  /** React useLayoutEffect → ECharts rendered 이벤트 */
  echartsRenderMs:    number | null;
  /** recv → ECharts rendered 전체 (react + echarts) */
  totalRecvRenderMs:  number | null;
  /** send → ECharts rendered 전체 E2E (RTT + react + echarts) */
  totalE2eMs:         number | null;
  /** 최신성 지연 (ms) — 렌더된 최신 frame time vs 현재 오디오 재생 시각 */
  freshnessLagMs:     number | null;
  /** 현재 streamingFrames 배열 길이 */
  streamingFramesLen: number;
  /** 현재 output queue에 대기 중인 프레임 수 */
  outputQueueLen:     number;
  /** 렌더 틱당 병합/드롭된 소스 프레임 수 */
  sourceCount:        number;
  /** 누적 드롭된 프레임 수 */
  droppedFrames:      number;
  /** 실제 렌더 업데이트 빈도 (Hz) */
  renderUpdateRate:   number | null;
  /** 보존된 이벤트 프레임 누적 수 */
  preservedEvents:    number;
}
