/**
 * engine/protocol/local-socket.ts — 브라우저 WebSocket API를 흉내 내는 로컬 WASM 소켓 -> 기존 서버를 이용한 Web Socket 구조에서 큰 변환을 안주기 위함의로 의도함.
 *
 * WaveformPlayer.tsx / MicrophonePlayer.tsx는 서버가 있던 시절 WebSocket을 직접 다뤘다
 * (init → binary PCM 프레임 → frame 메시지). 이 모듈은 그 좁은 인터페이스(SocketLike)만 흉내 내는 in-process 구현으로, 실제로는 adapters/wasm-client.ts(브라우저 WASM)를 직접 호출한다 — 서버(백엔드)가 전혀 없는 환경(정적 배포/Electron 패키징)에서 기존 컴포넌트 코드를 거의 바꾸지 않고도 동작하게 해준다.
 */

import type { EngineParams } from "../../../types";
import { openClientWasmSession } from "../adapters/wasm-client";
import { deinterleave } from "../utils";
import {
  DEFAULT_ENGINE_CONFIG, DEFAULT_AMBIENT_TEMP, BYTES_PER_SAMPLE, frameBytes,
  type AnalysisSession, type EngineRuntimeConfig, type RealSensingPair,
} from "../core";
import {
  parseEngineParams, parseSampleRate, parseSamplesPerCh,
  createFrameMessage, createReadyMessage, createErrorMessage,
  encodeProcessedPcmMessage,
} from "./analysis";

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
    const wireBytes = frameBytes(this.connConfig);
    if (data.byteLength < wireBytes) return;

    const currentFrame = this.frameCount;
    this.frameCount++;

    // analyze()가 감쇠 결과를 만들기 전에 입력을 떠 둔다 — 비교 뷰가 쓸 "감쇠 전" 원본이며,
    // 프레임 경계가 보호 PCM과 정확히 같아야 하므로 여기서 같은 버퍼를 잘라 쓴다.
    const input = new Int16Array(data.slice(0, wireBytes));

    // v_sensing/i_sensing 결정 — 어느 쪽이든 NULL은 넘기지 않는다(NULL이면 ff_prot.c가
    // PCM RMS 근사로 대체해버려서, 실측 센싱이 있는데도 근사로 도는 걸 눈치채기 어렵다).
    //
    //  1) sensing 꼬리가 붙어 있으면(4ch 이상 장치) 그걸 쓴다 — 정확히 2×samplesPerCh
    //     int16만큼 남아있을 때만 실측치로 취급하고, 애매하게 남는 바이트(잘못된 길이)는
    //     조용히 버린다(깨진 sensing보다 아래 폴백이 낫다).
    //  2) 꼬리가 없으면 buf의 ch0/ch1을 그대로 쓴다 — reframeNativeChunk.ts의 채널 규약상
    //     ch0=V(전압 센스)/ch1=I(전류 센스)라, 분석 buf에 실리는 그 두 채널이 곧 센싱
    //     데이터다. 이 경로에서 v_sensing/i_sensing은 buf와 같은 샘플을 가리킨다.
    const samplesPerCh = this.connConfig.samplesPerCh;
    const sensingStreamBytes = samplesPerCh * BYTES_PER_SAMPLE;
    let sensing: RealSensingPair;
    if (data.byteLength === wireBytes + sensingStreamBytes * 2) {
      sensing = {
        v: new Int16Array(data, wireBytes, samplesPerCh),
        i: new Int16Array(data, wireBytes + sensingStreamBytes, samplesPerCh),
      };
    } else {
      // deinterleave는 [ch0 samplesPerCh개][ch1 samplesPerCh개] 플래너를 새 배열로 돌려주므로
      // subarray 뷰를 그대로 넘겨도 안전하다(호출자와 버퍼를 공유하지 않는다).
      const planar = deinterleave(new Uint8Array(data, 0, wireBytes), samplesPerCh);
      sensing = {
        v: planar.subarray(0, samplesPerCh),
        i: planar.subarray(samplesPerCh, samplesPerCh * 2),
      };
    }

    try {
      const result = this.session.analyze(new Uint8Array(data), this.engineParams, sensing);
      this.emit(createFrameMessage(currentFrame, this.connConfig.sampleRate, this.connConfig.samplesPerCh, result));
      // 보호 감쇠가 적용된 PCM은 JSON에 못 실으므로 같은 frameIndex를 단 바이너리로 뒤따라 보낸다.
      if (result.processedPcm) {
        this.emitBinary(encodeProcessedPcmMessage(currentFrame, input, result.processedPcm));
      }
    } catch (err) {
      this.emit(createErrorMessage(`ff_prot_start_exec 오류: ${err}`));
    }
  }
}

/** 분석 소켓을 생성한다 — 항상 브라우저 WASM 엔진(LocalWasmSocket)을 사용한다. */
export function createAnalysisSocket(): SocketLike {
  return new LocalWasmSocket();
}
