const MAX_BACKLOG = 512;

export class ChannelHub<T> {
  private callbacks = new Set<(payload: T) => void>();
  private backlog: T[] = [];
  private warnedOverflow = false;

  reset(): void {
    this.backlog = [];
    this.warnedOverflow = false;
  }

  dispatch(payload: T): void {
    if (this.callbacks.size === 0) {
      if (this.backlog.length >= MAX_BACKLOG) {
        this.backlog.shift();
        if (!this.warnedOverflow) {
          console.warn(
            "[tauri-bridge] channel backlog full (>512 entries) — dropping oldest buffered messages until a subscriber registers",
          );
          this.warnedOverflow = true;
        }
      }
      this.backlog.push(payload);
      return;
    }
    for (const cb of this.callbacks) cb(payload);
  }

  subscribe(cb: (payload: T) => void): () => void {
    const shouldFlushBacklog = this.callbacks.size === 0 && this.backlog.length > 0;
    this.callbacks.add(cb);
    if (shouldFlushBacklog) {
      const buffered = this.backlog;
      this.backlog = [];
      for (const payload of buffered) cb(payload);
    }
    return () => {
      this.callbacks.delete(cb);
    };
  }
}
