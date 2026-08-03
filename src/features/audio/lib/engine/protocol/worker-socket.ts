import type { SocketLike } from "./socket-types";
import { e2e } from "@/features/audio/lib/perf-e2e/collector";

interface WorkerResultItem { json: string; bin: ArrayBuffer | null }
interface WorkerResultEnvelope {
  results: WorkerResultItem[];
  sentAt?: number;
  workerRecvAt?: number;
  workerDoneAt?: number;
}

export class WorkerAnalysisSocket implements SocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN       = 1;
  static readonly CLOSING    = 2;
  static readonly CLOSED     = 3;

  readyState = WorkerAnalysisSocket.CONNECTING;
  binaryType = "arraybuffer";

  readonly bufferedAmount = 0;

  onopen:    ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror:   ((ev: Event) => void) | null = null;
  onclose:   ((ev: Event) => void) | null = null;

  private readonly worker: Worker;

  private pendingFrames: ArrayBuffer[] = [];
  // e2e 실험이 켜졌을 때만 채워지는 큐잉 타임스탬프(N4) — pendingFrames와 같은 인덱스로 대응.
  private pendingQueuedAt: number[] = [];
  private flushScheduled = false;
  // init 엔벨로프를 워커에 실제로 넘겼는지. sendControl이 복호화(Tauri IPC)를 await하는 동안
  // 뒤이은 프레임이 먼저 도착할 수 있는데, 그러면 워커의 config가 아직 기본값이라 프레임
  // 길이 검사에서 번호도 못 받고 탈락한다(dsp-worker.ts의 frameBytes 가드) — 그만큼
  // frameIndex가 재생 위치와 어긋난다. init이 나갈 때까지 프레임을 붙들어 둔다.
  private initPosted = false;

  constructor() {
    this.worker = new Worker(new URL("../worker/dsp-worker.ts", import.meta.url));

    this.worker.onmessage = (e: MessageEvent) => {
      if (this.readyState === WorkerAnalysisSocket.CLOSED) return;
      const data = e.data as unknown;
      if (data && typeof data === "object" && Array.isArray((data as { results?: unknown }).results)) {
        const env = data as WorkerResultEnvelope;
        if (env.sentAt !== undefined && env.workerRecvAt !== undefined && env.workerDoneAt !== undefined) {
          // Date.now()(벽시계)로 재야 한다 — dedicated Worker의 performance.now() 시간 원점은
          // "그 Worker가 생성된 시점"이라 메인 스레드(페이지 로드 시점 기준)와 다르다. 두
          // 스레드가 timeOrigin을 공유한다는 잘못된 가정으로 performance.now()를 썼다가 상수
          // 오프셋(수십~수백 초)이 낀 값이 나온 적이 있다 — N1(프로세스 경계)처럼 반드시
          // Date.now()를 쓴다.
          const mainRecvAt = Date.now();
          e2e.sample("N3", env.workerRecvAt - env.sentAt);
          e2e.sample("N7", mainRecvAt - env.workerDoneAt);
        }
        for (const item of env.results) {
          this.onmessage?.({ data: item.json } as MessageEvent);
          if (item.bin) this.onmessage?.({ data: item.bin } as MessageEvent);
        }
        return;
      }
      this.onmessage?.({ data } as MessageEvent);
    };

    this.worker.onerror = (ev: ErrorEvent) => {
      if (this.readyState === WorkerAnalysisSocket.CLOSED) return;
      this.onerror?.(ev as unknown as Event);
    };

    queueMicrotask(() => {
      if (this.readyState === WorkerAnalysisSocket.CLOSED) return;
      this.readyState = WorkerAnalysisSocket.OPEN;
      this.onopen?.(new Event("open"));
    });
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== WorkerAnalysisSocket.OPEN) return;
    if (typeof data === "string") {
      this.flushFrames();
      void this.sendControl(data);
    } else {
      this.pendingFrames.push(data);
      if (e2e.isActive()) this.pendingQueuedAt.push(performance.now());
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => this.flushFrames());
      }
    }
  }

  // "init" 컨트롤 메시지만 별도 처리한다 — 워커 안에서 openClientWasmSession()이 WASM을
  // 로드할 때 암호화 배포(window.wasmAsset)가 필요한데, window는 이 메인 스레드에만 있고
  // Worker 전역 스코프엔 없다(과거 ReferenceError: Can't find variable: window의 원인).
  // 그래서 메인 스레드에서 미리 복호화해 init 페이로드에 실어 postMessage(transfer)로 넘긴다.
  private async sendControl(data: string): Promise<void> {
    let parsed: { type: string } & Record<string, unknown>;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.worker.postMessage(data);
      return;
    }
    if (parsed.type !== "init") {
      this.worker.postMessage(data);
      return;
    }
    // 복호화 실패를 그냥 던지면 unhandled rejection이 되고, 무엇보다 아래 postMessage가
    // 실행되지 않아 워커가 init을 영영 못 받는다 — 에러 없이 조용히 멈추는 셈이라 진단이
    // 어렵다. 여기서 잡아 onerror로 올리고 끝낸다.
    let wasmBinary: Uint8Array<ArrayBuffer> | undefined;
    try {
      wasmBinary = typeof window !== "undefined"
        ? await window.wasmAsset?.loadEngineBinary()
        : undefined;
    } catch (err) {
      if (this.readyState === WorkerAnalysisSocket.CLOSED) return;
      // init을 못 보내면 아래 flushFrames가 영영 프레임을 붙들고 있게 된다 — 흘려보낼 곳이
      // 없으므로 여기서 버려 메모리가 계속 불어나지 않게 한다.
      this.pendingFrames = [];
      this.pendingQueuedAt = [];
      this.onerror?.(new ErrorEvent("error", {
        message: `WASM 엔진 바이너리 복호화 실패: ${String(err)}`,
      }));
      return;
    }
    if (this.readyState === WorkerAnalysisSocket.CLOSED) return;
    if (wasmBinary) {
      this.worker.postMessage({ type: "init", initPayload: parsed, wasmBinary }, [wasmBinary.buffer]);
    } else {
      this.worker.postMessage({ type: "init", initPayload: parsed });
    }
    // init이 나간 뒤에야 그동안 쌓인 프레임을 흘려보낸다 — 순서가 뒤집히면 워커가 그
    // 프레임들을 config 없이 탈락시킨다.
    this.initPosted = true;
    this.flushFrames();
  }

  private flushFrames(): void {
    this.flushScheduled = false;
    if (!this.initPosted) return;
    if (this.pendingFrames.length === 0) return;
    const frames = this.pendingFrames;
    this.pendingFrames = [];

    const e2eActive = e2e.isActive();
    if (e2eActive && this.pendingQueuedAt.length > 0) {
      const now = performance.now();
      for (const queuedAt of this.pendingQueuedAt) e2e.sample("N4", now - queuedAt);
    }
    this.pendingQueuedAt = [];

    // sentAt도 Date.now() — 위 workerRecvAt/mainRecvAt과 같은 벽시계 기준이어야 뺄셈이 성립한다.
    const payload = e2eActive ? { frames, sentAt: Date.now() } : { frames };
    this.worker.postMessage(payload, frames);
  }

  close(): void {
    if (this.readyState === WorkerAnalysisSocket.CLOSED) return;
    this.readyState = WorkerAnalysisSocket.CLOSED;
    this.pendingFrames = [];
    this.pendingQueuedAt = [];
    try {
      this.worker.postMessage(JSON.stringify({ type: "stop" }));
    } catch {
    }
    this.worker.terminate();
    queueMicrotask(() => this.onclose?.(new Event("close")));
  }
}
