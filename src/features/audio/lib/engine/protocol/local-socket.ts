/**
 * engine/protocol/local-socket.ts — 브라우저 WebSocket API를 흉내 내는 로컬 WASM 소켓 -> 기존 서버를 이용한 Web Socket 구조에서 큰 변환을 안주기 위함의로 의도함.
 *
 * WaveformPlayer.tsx / MicrophonePlayer.tsx는 서버가 있던 시절 WebSocket을 직접 다뤘다
 * (init → binary PCM 프레임 → frame 메시지). 이 모듈은 그 좁은 인터페이스(SocketLike)만 흉내 내는 in-process 구현으로, 실제로는 adapters/wasm-client.ts(브라우저 WASM)를 직접 호출한다 — 서버(백엔드)가 전혀 없는 환경(정적 배포/Electron 패키징)에서 기존 컴포넌트 코드를 거의 바꾸지 않고도 동작하게 해준다.
 */

import type { EngineParams } from "../../../types";
import { openClientWasmSession } from "../adapters/wasm-client";
import {
  DEFAULT_ENGINE_CONFIG, DEFAULT_AMBIENT_TEMP, frameBytes,
  type AnalysisSession, type EngineRuntimeConfig,
} from "../core";
import {
  parseEngineParams, parseSampleRate, parseSamplesPerCh,
  createReadyMessage, createErrorMessage,
} from "./analysis";
import { processAnalysisFrame } from "./frame-core";
import { WorkerAnalysisSocket } from "./worker-socket";

/**
 * WaveformPlayer/MicrophonePlayer가 실제로 사용하는 WebSocket 부분집합.
 */
export interface SocketLike {
  readyState: number;
  binaryType: string;
  bufferedAmount: number;
  send(data: string | ArrayBuffer): void;
  close(): void;
  onopen:    ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror:   ((ev: Event) => void) | null;
  onclose:   ((ev: Event) => void) | null;
}

class LocalWasmSocket implements SocketLike {
  // WebSocket.readyState 상수와 동일한 값
  static readonly CONNECTING = 0;
  static readonly OPEN       = 1;
  static readonly CLOSING    = 2;
  static readonly CLOSED     = 3;

  readyState = LocalWasmSocket.CONNECTING;
  binaryType = "arraybuffer";
  
  // in-process 호출이라 전송 큐잉이 없음 — 항상 0(백프레셔 없음)
  readonly bufferedAmount = 0;

  onopen:    ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror:   ((ev: Event) => void) | null = null;
  onclose:   ((ev: Event) => void) | null = null;

  private session: AnalysisSession | null = null;
  private engineParams: EngineParams = { ampOutputPower: null, speakerModel: "", ambientTemp: DEFAULT_AMBIENT_TEMP };
  private connConfig: EngineRuntimeConfig = DEFAULT_ENGINE_CONFIG;
  private frameCount = 0;
  private initialized = false;

  constructor() {
    // 실제 WebSocket과 동일하게 다음 tick에 onopen을 흘려보낸다.
    queueMicrotask(() => {
      this.readyState = LocalWasmSocket.OPEN;
      this.onopen?.(new Event("open"));
    });
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== LocalWasmSocket.OPEN) return;
    if (typeof data === "string") {
      void this.handleControl(JSON.parse(data));
    } else {
      this.handleFrame(data);
    }
  }

  close(): void {
    if (this.readyState === LocalWasmSocket.CLOSED) return;
    this.readyState = LocalWasmSocket.CLOSED;
    this.session?.close();
    this.session = null;
    this.initialized = false;
    queueMicrotask(() => this.onclose?.(new Event("close")));
  }

  private emit(msg: Record<string, unknown>): void {
    queueMicrotask(() => {
      if (this.readyState === LocalWasmSocket.CLOSED) return;
      this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
    });
  }

  /** 바이너리 메시지(보호 PCM) — 실제 WebSocket의 binaryType="arraybuffer" 수신과 동일한 모양. */
  private emitBinary(data: ArrayBuffer): void {
    queueMicrotask(() => {
      if (this.readyState === LocalWasmSocket.CLOSED) return;
      this.onmessage?.({ data } as MessageEvent);
    });
  }

  // ── JSON 제어 메시지 (init/stop) ──────────────────────────────────────────
  private async handleControl(msg: { type: string } & Record<string, unknown>): Promise<void> {
    if (msg.type === "init") {
      if (this.initialized) {
        this.emit(createReadyMessage());
        return;
      }

      this.engineParams = parseEngineParams(msg);
      this.connConfig = {
        sampleRate: parseSampleRate(msg),
        samplesPerCh: parseSamplesPerCh(msg),
      };

      try {
        // includeProcessedPcm: 보호 감쇠가 적용된 PCM을 프레임마다 받아 바이너리로 흘려보낸다
        // (파형 비교 뷰 + WAV 내보내기용).
        this.session = await openClientWasmSession(this.connConfig, { includeProcessedPcm: true });
      } catch (err) {
        this.emit(createErrorMessage(String(err)));
        return;
      }

      this.initialized = true;
      this.frameCount  = 0;
      this.emit(createReadyMessage());

    } else if (msg.type === "stop") {
      this.session?.close();
      this.session = null;
      this.initialized = false;
    }
    // pause: 서버와 동일하게 별도 처리 없음(스트림은 클라이언트가 멈춤)
  }

  // ── Binary: PCM 프레임 — frameBytes(config) = samplesPerCh × 2ch × int16
  //    (기본 설정 480 samples 기준 1920 bytes). 캡처 장치가 4ch 이상이면
  //    reframeNativeChunk.ts가 이 뒤에 [V samples][I samples](모노, 각 samplesPerCh ×
  //    int16)를 이어 붙여 보낸다 — byteLength로 존재 여부를 판단한다(프로토콜 버전 필드
  //    없이 길이만으로 구분: 2ch만 있는 getUserMedia 폴백/구버전 캡처와도 호환). ────────
  private handleFrame(data: ArrayBuffer): void {
    if (!this.initialized || !this.session) return;
    // 와이어 크기 미만이면 프레임 인덱스를 소비하지 않고 버린다(짧은/깨진 프레임).
    if (data.byteLength < frameBytes(this.connConfig)) return;

    const currentFrame = this.frameCount++;

    // deinterleave/sensing 선택 + analyze + 메시지 구성은 frame-core에 있다 — 워커 경로
    // (dsp-worker.ts)와 ABI 민감부를 공유해 두 경로가 갈라지지 않게 한다.
    try {
      const out = processAnalysisFrame(this.session, data, this.engineParams, this.connConfig, currentFrame);
      if (!out) return;
      this.emit(out.frameJson as Record<string, unknown>);
      // 보호 감쇠 PCM은 JSON에 못 실으므로 같은 frameIndex를 단 바이너리로 뒤따라 보낸다.
      if (out.binary) this.emitBinary(out.binary);
    } catch (err) {
      this.emit(createErrorMessage(`ff_prot_start_exec 오류: ${err}`));
    }
  }
}

/**
 * 분석 소켓을 생성한다. 두 백엔드 모두 같은 브라우저 WASM 엔진을 쓰지만 실행 위치가 다르다:
 *   - WorkerAnalysisSocket : Web Worker (기본) — 100fps 분석을 렌더 스레드에서 뺀다
 *   - LocalWasmSocket      : 메인 스레드 in-process (opt-out / 폴백)
 *
 * 기본이 워커 경로다. NEXT_PUBLIC_USE_WORKER_ENGINE=0 으로 명시적으로 끄면 메인 스레드 엔진을
 * 쓴다(롤백은 이 플래그 하나). 또한 워커 생성 자체가 막힌 환경에선 자동으로 in-process로
 * 폴백한다. SocketLike 인터페이스가 같아 상위 컴포넌트(useCaptureSession 등)는 어느 쪽이든
 * 코드 변경이 없다.
 */
export function createAnalysisSocket(): SocketLike {
  // 명시적 opt-out만 메인 스레드 경로.
  if (process.env.NEXT_PUBLIC_USE_WORKER_ENGINE === "0") {
    return new LocalWasmSocket();
  }
  try {
    return new WorkerAnalysisSocket();
  } catch (err) {
    // 워커 생성이 막힌 런타임(구형 등)에선 in-process 엔진으로 폴백해 앱이 죽지 않게 한다.
    console.warn("Web Worker 분석 엔진 생성 실패 — 메인 스레드 엔진으로 폴백합니다.", err);
    return new LocalWasmSocket();
  }
}
