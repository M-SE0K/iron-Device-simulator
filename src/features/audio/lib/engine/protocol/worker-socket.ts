import type { SocketLike } from "./local-socket";

interface WorkerResultItem { json: string; bin: ArrayBuffer | null }

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
  private flushScheduled = false;

  constructor() {
    this.worker = new Worker(new URL("../worker/dsp-worker.ts", import.meta.url));

    this.worker.onmessage = (e: MessageEvent) => {
      if (this.readyState === WorkerAnalysisSocket.CLOSED) return;
      const data = e.data as unknown;
      if (data && typeof data === "object" && Array.isArray((data as { results?: unknown }).results)) {
        for (const item of (data as { results: WorkerResultItem[] }).results) {
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
    this.worker.postMessage({ frames }, frames);
  }

  close(): void {
    if (this.readyState === WorkerAnalysisSocket.CLOSED) return;
    this.readyState = WorkerAnalysisSocket.CLOSED;
    this.pendingFrames = [];
    try {
      this.worker.postMessage(JSON.stringify({ type: "stop" }));
    } catch {
    }
    this.worker.terminate();
    queueMicrotask(() => this.onclose?.(new Event("close")));
  }
}
