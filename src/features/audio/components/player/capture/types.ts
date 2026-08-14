import type { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import type { DecodedPlayback } from "@/features/audio/lib/codec/playback-decode";

export type CaptureStreamEvent =
  | { type: "reset"; channels: number; sampleRate: number }
  | { type: "chunk"; chunk: ArrayBuffer; channels: number; sampleRate: number }
  | { type: "protected"; frameIndex: number; input: Int16Array; processed: Int16Array; sampleRate: number };

export type CaptureStreamListener = (ev: CaptureStreamEvent) => void;

/**
 * 스피커로 무엇을 내보낼지.
 * - `protected`: 재생 PCM을 ff_prot에 먼저 통과시킨 뒤 그 결과만 내보낸다(기본).
 *   실측 V/I가 아직 없는 시작 구간은 V/I=0으로 처리한다 — docs/protected-playback-plan.md.
 * - `original`: 업로드한 원본을 그대로 내보낸다. 보호 유/무를 같은 리그에서 비교하는 A/B용.
 */
export type PlaybackMode = "protected" | "original";

/**
 * 보호 스트리밍 재생에서 `useCaptureSession`(엔진 메시지를 받는 쪽)과
 * `useNativeCapture`(재생 원본과 크레딧을 들고 있는 쪽)를 잇는 얇은 접점.
 * 루프가 두 훅에 걸쳐 있어 어느 한쪽만으로는 닫히지 않는다 — 엔진 소켓은 세션 훅이 소유하고,
 * "다음에 어느 프레임을 넣을지"는 캡처 훅만 알기 때문이다.
 */
export interface PlaybackStreamPump {
  /** 엔진 준비 완료 — 프리필(리드 프레임)을 즉시 처리·전송한다. */
  onEngineReady: () => void;
  /** 엔진이 보호 감쇠 PCM을 돌려줄 때마다 — 헬퍼 재생 링으로 밀어 넣는다. */
  pushProtected: (processed: Int16Array) => void;
}

/**
 * 세션 시작~현재까지 캡처된 전 채널 원본 PCM을 복사 없이 들여다보는 스냅샷.
 * getRecordedBlob()(WAV 인코딩, Workspace 저장 전용)과 달리 이건 O(1)이다 — `frames`가
 * rawCaptureRef가 들고 있는 배열 참조 그대로라, 세션이 길어져도 호출 비용이 늘지 않는다.
 * 채널 목록 확인과 신규 선택 채널의 초기 백필처럼 "읽기만" 하는 경로는 이쪽을 쓴다.
 */
export interface CaptureSnapshot {
  channels: number;
  sampleRate: number;
  /** 인터리브 int16 프레임들. 살아있는 참조 — 이후 도착분이 계속 append된다. */
  frames: readonly ArrayBuffer[];
  /** 프레임 1개가 담는 채널당 샘플 수. reframer가 고정 크기로 내므로 전 프레임 동일하다. */
  samplesPerFrame: number;
  /** 스냅샷 시점의 누적 채널당 샘플 수 = frames.length * samplesPerFrame. */
  totalFrames: number;
}

export interface UseCaptureSessionDeps {
  status: AppStatus;
  onStatusChange: (s: AppStatus) => void;
  onFrameReceived: (frame: AnalysisFrame) => void;
  onStreamStart: () => void;
  inputParams: InputParameterValues | undefined;
  /** 세션 시작 시점에만 반영된다 — 재생 중 전환은 엔진 상태·클록 정합이 깨진다. */
  playbackMode?: PlaybackMode;
}

export interface WaveformPlayerHandle {
  sendMessage: (msg: object) => void;
  pause: () => void;
  exportRecordedAudio: () => Blob | null;
  exportProtectedAudio: () => Blob | null;
  getCaptureSnapshot: () => CaptureSnapshot | null;
  subscribeCaptureStream: (fn: CaptureStreamListener) => () => void;
  /**
   * 재생용으로 이미 디코딩해 둔 원본 PCM(인터리브 스테레오). 파일 선택 시 한 번 디코딩되는
   * 값이라, 원본 파형이 필요한 쪽(Protection 패널의 Input 엔벨로프)이 같은 파일을 다시
   * decodeAudioData하지 않고 이걸 소화한다. 디코딩 전/실패/파일 없음이면 null.
   */
  getDecodedPlayback: () => DecodedPlayback | null;
}
