/**
 * engine/protocol/worker-socket.ts — Web Worker 백엔드 SocketLike
 *
 * LocalWasmSocket과 동일한 SocketLike 인터페이스를 구현하되, 실제 분석(WASM ff_prot +
 * deinterleave/interleave + 보호 PCM 인코딩)은 worker/dsp-worker.ts에서 돈다. 메인 스레드는
 * PCM을 워커로 넘기고(transfer) 결과만 받으므로 100fps 상시 부하가 렌더 스레드에서 빠진다.
 *
 * 워커는 실제 WebSocket 수신과 동일한 모양(문자열=JSON, ArrayBuffer=바이너리)으로만 보내므로
 * onmessage에서 e.data를 그대로 중계하면 소비자(useCaptureSession)는 코드 변경이 없다.
 */

import type { SocketLike } from "./local-socket";

export class WorkerAnalysisSocket implements SocketLike {
  // WebSocket.readyState 상수와 동일한 값(호출부의 ws.readyState === WebSocket.OPEN 비교와 호환)
  static readonly CONNECTING = 0;
  static readonly OPEN       = 1;
  static readonly CLOSING    = 2;
  static readonly CLOSED     = 3;

  readyState = WorkerAnalysisSocket.CONNECTING;
  binaryType = "arraybuffer";

  // 전송 큐 백프레셔는 아직 노출하지 않는다(호출부는 readyState만 본다) — 실 백프레셔 계측은
  // 후속 확장(SharedArrayBuffer/Atomics)에서. LocalWasmSocket과 동일하게 0으로 둔다.
  readonly bufferedAmount = 0;

  onopen:    ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror:   ((ev: Event) => void) | null = null;
  onclose:   ((ev: Event) => void) | null = null;

  private readonly worker: Worker;

  constructor() {
    // new URL(..., import.meta.url)로 워커를 참조하면 webpack(Next15)이 별도 청크로 번들한다.
    // type을 지정하지 않으므로 classic worker가 되고, dsp-worker가 ff_prot.js를 importScripts로
    // 로드할 수 있다(module worker면 importScripts가 없음 — wasm-client.ts loadFactory 분기 참고).
    this.worker = new Worker(new URL("../worker/dsp-worker.ts", import.meta.url));

    this.worker.onmessage = (e: MessageEvent) => {
      if (this.readyState === WorkerAnalysisSocket.CLOSED) return;
      // 워커는 문자열(ready/frame/error JSON) 또는 ArrayBuffer(보호 PCM)만 보낸다 —
      // 실제 WebSocket 수신과 동일한 모양이라 그대로 중계한다.
      this.onmessage?.({ data: e.data } as MessageEvent);
    };

    this.worker.onerror = (ev: ErrorEvent) => {
      if (this.readyState === WorkerAnalysisSocket.CLOSED) return;
      this.onerror?.(ev as unknown as Event);
    };

    // 실제 WebSocket과 동일하게 다음 tick에 onopen을 흘린다 — 이 시점엔 호출부가 onopen을
    // 이미 붙였다(createAnalysisSocket() 반환 직후 지정). 워커 로드/WASM init은 이후 init
    // 메시지에서 시작되고, 준비되면 워커가 ready를 보낸다(LocalWasmSocket과 동일한 핸드셰이크).
    queueMicrotask(() => {
      if (this.readyState === WorkerAnalysisSocket.CLOSED) return;
      this.readyState = WorkerAnalysisSocket.OPEN;
      this.onopen?.(new Event("open"));
    });
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== WorkerAnalysisSocket.OPEN) return;
    if (typeof data === "string") {
      this.worker.postMessage(data);
    } else {
      // PCM 프레임은 transfer로 넘겨 메인 스레드 복사를 없앤다. 호출부는 send 후 이 버퍼를
      // 재사용하지 않는다(native: reframe 결과의 slice 복사본, web: 매 프레임 새 interleaved).
      this.worker.postMessage(data, [data]);
    }
  }

  close(): void {
    if (this.readyState === WorkerAnalysisSocket.CLOSED) return;
    this.readyState = WorkerAnalysisSocket.CLOSED;
    // 워커에 stop을 알려 세션 자원(WASM 힙)을 정리한 뒤 종료한다. terminate만으로도 워커는
    // 사라지지만, stop_exec을 못 부르면 누적 실패 통계 로그가 남지 않는다(dsp-worker close 참고).
    try {
      this.worker.postMessage(JSON.stringify({ type: "stop" }));
    } catch {
      // 워커가 이미 죽었으면 무시
    }
    this.worker.terminate();
    queueMicrotask(() => this.onclose?.(new Event("close")));
  }
}
