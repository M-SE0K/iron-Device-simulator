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
