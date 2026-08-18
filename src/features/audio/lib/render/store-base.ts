export abstract class SubscribableStore {
  private listeners = new Set<() => void>();
  protected ver = 0;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  protected bump(): void {
    this.ver++;
    this.listeners.forEach((fn) => fn());
  }
}

export abstract class VersionedSnapshotStore<
  TSnapshot extends { version: number },
> extends SubscribableStore {
  protected dirty = false;
  private cached: TSnapshot | null = null;

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.invalidate();
  }

  protected invalidate(): void {
    this.cached = null;
    this.bump();
  }

  snapshot(): TSnapshot {
    if (this.cached === null || this.ver === 0 || this.cached.version !== this.ver) {
      this.cached = this.buildSnapshot();
    }
    return this.cached;
  }

  protected abstract buildSnapshot(): TSnapshot;
}
