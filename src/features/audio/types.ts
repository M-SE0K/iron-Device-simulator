/** 분석 엔진 파라미터 (CalibrationDrawer/calibration-context에서 수집) */
export interface EngineParams {
  /** AMP 출력 전력 (W). null = 미설정 → 기본 20W로 간주 */
  ampOutputPower: number | null;
  /** 스피커 모델 ID. "" = 미선택 → 기본 프로파일 사용 */
  speakerModel: string;
  /** 주변 온도 (°C) — ff_prot_start_exec 인자. 미설정/파싱 실패 시 기본 25°C */
  ambientTemp: number;
}

/** EngineParams의 폼 draft 표현 (숫자 입력 필드가 파싱 전 문자열을 들고 있는 동안 사용) */
export interface InputParameterValues {
  ampOutputPower: string;
  speakerModel: string;
  ambientTemp: string;
}

/** 오디오 분석 결과 한 프레임 */
export interface AnalysisFrame {
  /** 오디오 재생 시간(초) */
  time: number;
  /** 스피커 온도 (°C) — [ch0(L), ch1(R)] */
  temperature: [number, number];
  /** 스피커 진폭 변위 — [ch0(L), ch1(R)] */
  excursion: [number, number];
  // ── Step 5: Coalescing metadata (선택적) ──────────────────────────────
  /** 병합된 소스 프레임 수 (1이면 병합 없음) */
  sourceCount?: number;
  /** 병합 구간 시작 시각 */
  timeStart?: number;
  /** 병합 구간 종료 시각 */
  timeEnd?: number;
  /** 병합 구간 내 excursion 최솟값 — [ch0, ch1] */
  excursionMin?: [number, number];
  /** 병합 구간 내 excursion 최댓값 — [ch0, ch1] */
  excursionMax?: [number, number];
  /** 병합 구간 내 temperature 최댓값 — [ch0, ch1] */
  temperatureMax?: [number, number];
  // ── Step 6: Event-Preserving metadata ─────────────────────────────────
  /** 이벤트 프레임 여부 */
  isEvent?: boolean;
  /** 이벤트 유형 */
  eventType?: "temp_warn" | "temp_danger" | "exc_peak";
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

// ─── WebSocket 메시지 타입 ───────────────────────────────────────────────────

/** 서버 → 클라이언트 */
export type WsServerMessage =
  | { type: "ready" }
  | { type: "frame"; time: number; temperature: [number, number]; excursion: [number, number]; processingMs: number }
  | { type: "error"; message: string };

// 디버그 로그 / 스트리밍 디버그 정보 / 측정 세션 export 타입은
// features/audio/lib/debug/types.ts 로 분리됨 (DebugLogEntry, StreamDebugInfo, MeasurementExport).
