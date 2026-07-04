/**
 * engine/protocol/local-socket.ts — 서버 WebSocket을 흉내 내는 로컬 WASM 소켓 (모바일 앱 전용)
 *
 * WaveformPlayer.tsx / MicrophonePlayer.tsx는 원래 서버(protocol/ws.ts)와 통신하는
 * WebSocket을 직접 다룬다(init → binary PCM 프레임 → frame 메시지). 이 모듈은 그
 * 좁은 인터페이스(SocketLike)만 흉내 내는 in-process 구현으로, 실제로는 서버 대신
 * adapters/wasm-client.ts(브라우저 WASM)를 호출한다 — Capacitor 모바일 빌드처럼
 * 백엔드가 번들에 없는 환경에서 기존 컴포넌트 코드를 거의 바꾸지 않고도 서버 없이
 * 동작하게 해준다. createAnalysisSocket()으로 일반 웹(WS)/로컬(WASM)을 스위칭한다.
 */

import type { EngineParams } from "../../../types";
import { openClientWasmSession } from "../adapters/wasm-client";
import { SAMPLE_RATE, SAMPLES_PER_CH, FRAME_BYTES, type AnalysisSession } from "../core";
import {
  parseEngineParams, parseSampleRate,
  createFrameMessage, createReadyMessage, createErrorMessage,
} from "./analysis";

/**
 * WaveformPlayer/MicrophonePlayer가 실제로 사용하는 WebSocket 부분집합.
 * 이벤트 핸들러는 일부러 `any`로 느슨하게 잡아, 네이티브 WebSocket(구체적인
 * CloseEvent/MessageEvent 타입 사용)이 구조적으로 그대로 대입 가능하게 한다.
 */
export interface SocketLike {
  readyState: number;
  binaryType: string;
  bufferedAmount: number;
  send(data: string | ArrayBuffer): void;
  close(): void;
  onopen:    ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onerror:   ((ev: any) => void) | null;
  onclose:   ((ev: any) => void) | null;
}

/** 빌드 시 NEXT_PUBLIC_LOCAL_ENGINE=true 로 굽는 모바일(Capacitor) 빌드에서만 true. */
export function isLocalEngineMode(): boolean {
  return process.env.NEXT_PUBLIC_LOCAL_ENGINE === "true";
}

export class LocalWasmSocket implements SocketLike {
  // WebSocket.readyState 상수와 동일한 값
  static readonly CONNECTING = 0;
  static readonly OPEN       = 1;
  static readonly CLOSING    = 2;
  static readonly CLOSED     = 3;

  readyState = LocalWasmSocket.CONNECTING;
  binaryType = "arraybuffer";
  // in-process 호출이라 전송 큐잉이 없음 — 항상 0(백프레셔 없음)
  readonly bufferedAmount = 0;

  onopen:    ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onerror:   ((ev: any) => void) | null = null;
  onclose:   ((ev: any) => void) | null = null;

  private session: AnalysisSession | null = null;
  private engineParams: EngineParams = { ampOutputPower: null, speakerModel: "" };
  private connSampleRate = SAMPLE_RATE;
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

  // ── JSON 제어 메시지 (protocol/ws.ts와 동일 프로토콜) ─────────────────────────
  private async handleControl(msg: { type: string } & Record<string, unknown>): Promise<void> {
    if (msg.type === "init") {
      if (this.initialized) {
        this.emit(createReadyMessage());
        return;
      }

      this.engineParams = parseEngineParams(msg);
      this.connSampleRate = parseSampleRate(msg);

      try {
        this.session = await openClientWasmSession();
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

  // ── Binary: PCM 프레임 1920 bytes (protocol/ws.ts 바이너리 분기와 동일 로직) ───
  private handleFrame(data: ArrayBuffer): void {
    if (!this.initialized || !this.session) return;
    if (data.byteLength < FRAME_BYTES) return;

    const currentFrame = this.frameCount;
    this.frameCount++;

    try {
      const result = this.session.analyze(new Uint8Array(data), this.engineParams);
      this.emit(createFrameMessage(currentFrame, this.connSampleRate, result));
    } catch (err) {
      this.emit(createErrorMessage(`ff_prot_start_exec 오류: ${err}`));
    }
  }
}

/** 일반 웹 빌드는 서버 WebSocket을, 모바일(로컬 엔진) 빌드는 LocalWasmSocket을 반환한다. */
export function createAnalysisSocket(wsUrl: string): SocketLike {
  if (isLocalEngineMode()) return new LocalWasmSocket();
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";
  return ws;
}
