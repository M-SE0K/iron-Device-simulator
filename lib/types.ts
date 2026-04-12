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
  | { type: "stop" };

/** 서버 → 클라이언트 */
export type WsServerMessage =
  | { type: "ready" }
  | { type: "frame"; time: number; temperature: number; excursion: number; processingMs: number }
  | { type: "error"; message: string };

// ─── 스트리밍 디버그 정보 ────────────────────────────────────────────────────

/** 프레임 단위 디버그 로그 엔트리 */
export interface DebugLogEntry {
  /** 브라우저 기준 수신 절대 시각 (ms) */
  receivedAt:    number;
  /** 오디오 타임라인 상 프레임 시각 (s) */
  audioTime:     number;
  frameIdx:      number;
  /** 클라이언트 왕복 지연 (ms), null이면 timestamp 분실 */
  rttMs:         number | null;
  /** 서버 ff_prot 처리 시간 (ms) */
  serverProcMs:  number;
  temperature:   number;
  excursion:     number;
}

export interface StreamDebugInfo {
  wsConnected:       boolean;
  framesSent:        number;
  framesReceived:    number;
  /** 마지막 프레임 왕복 지연 (client→server→client, ms) */
  latestRttMs:       number | null;
  /** 최근 100프레임 평균 RTT (ms) */
  avgRttMs:          number | null;
  minRttMs:          number | null;
  maxRttMs:          number | null;
  /** 서버 측 ff_prot 처리 시간 (ms) */
  serverProcessingMs: number | null;
  /** rAF 루프 프레임 전송 속도 (frames/s) */
  sendRateFps:       number | null;
}
