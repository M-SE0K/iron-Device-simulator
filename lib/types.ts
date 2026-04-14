/** 분석 엔진 파라미터 (InputParameters 컴포넌트에서 수집) */
export interface EngineParams {
  /** AMP 출력 전력 (W). null = 미설정 → 기본 20W로 간주 */
  ampOutputPower: number | null;
  /** 스피커 모델 ID. "" = 미선택 → 기본 프로파일 사용 */
  speakerModel: string;
}

/** 오디오 분석 결과 한 프레임 */
export interface AnalysisFrame {
  /** 오디오 재생 시간(초) */
  time: number;
  /** 칩 온도 (°C) */
  temperature: number;
  /** 스피커 진폭 변위 (mm) */
  excursion: number;
}

/** 업로드 → 분석 → 시각화 상태 */
export type AppStatus =
  | "idle"       // 파일 업로드 전
  | "uploading"  // 파일 업로드 중
  | "analyzing"  // 서버에서 분석 중
  | "ready"      // 분석 완료, 재생 가능
  | "playing"    // 재생 중
  | "paused"     // 일시정지
  | "error";     // 에러

export interface AnalysisResult {
  filename: string;
  duration: number;   // 전체 길이(초)
  sampleRate: number;
  frames: AnalysisFrame[];
}

// ─── WebSocket 메시지 타입 ───────────────────────────────────────────────────

/** 클라이언트 → 서버 */
export type WsClientMessage =
  | { type: "init" }
  | { type: "pause" }
  | { type: "stop" }
  | {
      type:              "metrics";
      frameIdx:          number;
      audioTime:         number;
      rttMs:             number | null;
      serverProcMs:      number | null;
      reactRenderMs:     number | null;
      echartsRenderMs:   number | null;
      totalRecvRenderMs: number | null;
      totalE2eMs:        number | null;
    };

/** 서버 → 클라이언트 */
export type WsServerMessage =
  | { type: "ready" }
  | { type: "frame"; time: number; temperature: number; excursion: number; processingMs: number }
  | { type: "error"; message: string };

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
  /** 서버 ff_prot 처리 시간 (ms) */
  serverProcMs:      number;
  temperature:       number;
  excursion:         number;
  /** recv → React useLayoutEffect (직전 렌더 사이클 값) */
  reactRenderMs:     number | null;
  /** React useLayoutEffect → ECharts rendered 이벤트 */
  echartsRenderMs:   number | null;
  /** recv → ECharts rendered (react + echarts 합산) */
  totalRecvRenderMs: number | null;
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
    rtt:         { avg: number | null; min: number | null; max: number | null };
    serverProc:  { avg: number | null };
    temperature: { avg: number;        min: number;        max: number        };
    excursion:   { avg: number;        min: number;        max: number        };
    /** RTT + recv→render 합산 End-to-End */
    e2e:         { avg: number | null; min: number | null; max: number | null };
  };
  frames: DebugLogEntry[];
}

export interface StreamDebugInfo {
  wsConnected:        boolean;
  framesSent:         number;
  framesReceived:     number;
  /** 마지막 프레임 왕복 지연 (client→server→client, ms) */
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
}
