import type { SocketLike } from "./local-socket";
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
      this.worker.postMessage(data);
    } else {
      this.pendingFrames.push(data);
      if (e2e.isActive()) this.pendingQueuedAt.push(performance.now());
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => this.flushFrames());
      }
    }
  }

  private flushFrames(): void {
    this.flushScheduled = false;
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
