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

/** 캘리브레이션 파라미터 전체 (CalibrationContext 단일 소스, CalibrationDrawer가 편집) */
export interface CalibrationValues {
  speakerModel: string; // "" = 미선택
  ampOutputPower: string; // W
  ambientTemp: string; // °C — ff_prot_start_exec에 그대로 전달되는 엔진 입력값(EngineParams.ambientTemp)
  sampleRate: string; // Hz (데모)
  bufferSize: string; // samples (데모)
  channels: string; // 캡처 채널 수 (네이티브 캡처 전용)
  inputDeviceId: string; // MediaDevices deviceId ("" = 시스템 기본 입력) — 마이크 캡처 대상
  inputDeviceLabel: string; // 선택 장치 이름(표시/재연결 대조용)
  captureDeviceUID: string; // CoreAudio 장치 UID ("" = OS 기본 입력) — 네이티브 캡처/조회 대상(Electron 전용)
  outputDeviceId: string; // MediaDevices deviceId ("" = 시스템 기본 출력) — 재생 라우팅 대상(WaveSurfer setSinkId). V/I 센싱 루프에서 앰프/스피커(MCHStreamer)로 음원을 보내는 출력.
  outputDeviceLabel: string; // 선택 출력 장치 이름(표시/재연결 대조용)
  outputChannel: string; // play-capture가 재생을 내보낼 출력 채널 인덱스("0"=ch0, 네이티브 전용). 멀티채널 앰프 구성 대응.
  tempBase: string; // °C (프로파일)
  excAmp: string; // mm (프로파일)
  tempMult: string; // 승수
  excMult: string; // 승수
  tempWarn: string; // °C — 온도 WARN 임계값(차트 markLine + detectEvents 이벤트 감지 공용)
  tempDanger: string; // °C — 온도 DANGER 임계값(차트 markLine + detectEvents 이벤트 감지 공용)
}

/** 오디오 분석 결과 한 프레임 */
export interface AnalysisFrame {
  /** 오디오 재생 시간(초) */
  time: number;
  /** 스피커 온도 (°C) — [ch0(V), ch1(I)] */
  temperature: [number, number];
  /** 스피커 진폭 변위 — [ch0(V), ch1(I)] */
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
  | "analyzing"  // 분석 엔진 처리 중
  | "ready"      // 분석 완료, 재생 가능
  | "playing"    // 재생 중
  | "paused"     // 일시정지
  | "error";     // 에러

// ─── SocketLike 메시지 타입 ───────────────────────────────────────────────────

/** 엔진 → 클라이언트 */
export type WsServerMessage =
  | { type: "ready" }
  | { type: "frame"; time: number; temperature: [number, number]; excursion: [number, number]; processingMs: number }
  | { type: "error"; message: string };
