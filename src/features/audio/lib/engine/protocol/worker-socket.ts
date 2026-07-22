/**
 * engine/protocol/worker-socket.ts — Web Worker 백엔드 SocketLike
 *
 * LocalWasmSocket과 동일한 SocketLike 인터페이스를 구현하되, 실제 분석(WASM ff_prot +
 * deinterleave/interleave + 보호 PCM 인코딩)은 worker/dsp-worker.ts에서 돈다. 메인 스레드는
 * PCM을 워커로 넘기고(transfer) 결과만 받으므로 100fps 상시 부하가 렌더 스레드에서 빠진다.
 *
 * 배치(Stage 1): send(PCM)를 즉시 보내지 않고 대기 버퍼에 모았다가 microtask로 한 번에
 * 워커로 보낸다({frames:[…]}). 워커도 결과를 배치({results:[…]})로 돌려주고, 여기서 프레임별
 * onmessage(문자열 + ArrayBuffer)로 풀어 중계한다 — 소비자(useCaptureSession)는 여전히
 * 프레임 단위 메시지를 받으므로 코드 변경이 없다. 목적은 고레이트(작은 버퍼)에서 폭증하던
 * postMessage 왕복 횟수를 청크 단위로 줄이는 것(프레임당 → 청크당).
 */

import type { SocketLike } from "./local-socket";

/** 워커→메인 배치 결과 한 항목 — frameJson(문자열) + 보호 PCM(있으면). */
interface WorkerResultItem { json: string; bin: ArrayBuffer | null }

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

  // 송신 배치용 대기 버퍼 — send(PCM)를 모았다가 microtask로 한 번에 전송한다. 캡처가 한 청크의
  // 프레임들을 동기 버스트로 send하므로, 그 버스트가 콜백 종료 직후 한 메시지로 묶여 나간다(지연 ≈ 0).
  private pendingFrames: ArrayBuffer[] = [];
  private flushScheduled = false;

  constructor() {
    // new URL(..., import.meta.url)로 워커를 참조하면 webpack(Next15)이 별도 청크로 번들한다.
    // type을 지정하지 않으므로 classic worker가 되고, dsp-worker가 ff_prot.js를 importScripts로
    // 로드할 수 있다(module worker면 importScripts가 없음 — wasm-client.ts loadFactory 분기 참고).
    this.worker = new Worker(new URL("../worker/dsp-worker.ts", import.meta.url));

    this.worker.onmessage = (e: MessageEvent) => {
      if (this.readyState === WorkerAnalysisSocket.CLOSED) return;
      const data = e.data as unknown;
      // 프레임 결과 배치({results:[…]})는 프레임별로 풀어 기존과 동일하게 중계한다 —
      // 소비자는 프레임당 문자열(frameJson) + ArrayBuffer(보호 PCM)를 순서대로 받는다.
      if (data && typeof data === "object" && Array.isArray((data as { results?: unknown }).results)) {
        for (const item of (data as { results: WorkerResultItem[] }).results) {
          this.onmessage?.({ data: item.json } as MessageEvent);
          if (item.bin) this.onmessage?.({ data: item.bin } as MessageEvent);
        }
        return;
      }
      // 그 외(ready/error 문자열)는 실제 WebSocket 수신 모양 그대로 중계한다.
      this.onmessage?.({ data } as MessageEvent);
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
      // 제어 메시지(init/stop)는 대기 중인 프레임보다 순서가 앞서야 하므로 먼저 flush한다.
      this.flushFrames();
      this.worker.postMessage(data);
    } else {
      // PCM 프레임은 즉시 보내지 않고 모은다 — 캡처 청크의 동기 버스트가 콜백 종료 후 한 메시지로
      // 묶여 나간다. 호출부는 send 후 이 버퍼를 재사용하지 않는다(native: reframe 결과의 slice
      // 복사본, web: 매 프레임 새 interleaved)라 flush에서 transfer해도 안전하다.
      this.pendingFrames.push(data);
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => this.flushFrames());
      }
    }
  }

  /** 대기 중인 PCM 프레임들을 하나의 배치 메시지로 워커에 전송한다(버퍼 전부 transfer). */
  private flushFrames(): void {
    this.flushScheduled = false;
    if (this.pendingFrames.length === 0) return;
    const frames = this.pendingFrames;
    this.pendingFrames = [];
    this.worker.postMessage({ frames }, frames);
  }

  close(): void {
    if (this.readyState === WorkerAnalysisSocket.CLOSED) return;
    this.readyState = WorkerAnalysisSocket.CLOSED;
    // 종료하므로 아직 안 보낸 대기 프레임은 버린다(세션이 끝나 결과가 필요 없다).
    this.pendingFrames = [];
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
