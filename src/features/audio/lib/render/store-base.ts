/**
 * 렌더 스토어(ChartStore/ChannelWaveStore/AnnotationStore)가 공유하는 구독·버전 인프라.
 *
 * 이 스토어들은 표시 데이터를 React 상태 밖에서 들고 있고 구독자(uPlot 커밋 경로)가 직접
 * 그린다 — 공통 골격은 (1) 인스턴스에 바인딩된 안정된 subscribe 참조(이펙트 의존성에
 * 그대로 넣어도 재구독이 없다), (2) 변경마다 올라가는 버전, (3) 알림 규약 두 가지
 * (배치 push 후 flush() / 변경 즉시 bump())다. 예전엔 세 스토어가 이 골격을 각자
 * 복제하고 있었다.
 */

export abstract class SubscribableStore {
  private listeners = new Set<() => void>();
  protected ver = 0;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  /** 버전을 올리고 구독자에게 알린다 — 변경 즉시 알리는 스토어(AnnotationStore)의 경로. */
  protected bump(): void {
    this.ver++;
    this.listeners.forEach((fn) => fn());
  }
}

/**
 * 버전별 스냅샷 캐시와 배치 알림(flush)을 더한 표시 스토어 베이스. push/addBlock류는
 * dirty 표시만 하고, flush() 시점에만 버전이 오르고 구독자에게 알린다 — 실제 그리기
 * 빈도는 구독자가 정한다(차트는 rAF로 합쳐 최대 실제 화면 주사율로 커밋한다).
 */
export abstract class VersionedSnapshotStore<
  TSnapshot extends { version: number },
> extends SubscribableStore {
  protected dirty = false;
  private cached: TSnapshot | null = null;

  /** 마지막 flush 이후 변경(dirty)이 있으면 버전을 올리고 구독자에게 알린다. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.invalidate();
  }

  /** 스냅샷 캐시 무효화 + 버전 증가 + 알림 — reset()류가 직접 부른다. */
  protected invalidate(): void {
    this.cached = null;
    this.bump();
  }

  /** 스칼라 요약 — 버전이 같은 동안 캐시돼 렌더마다 읽어도 비용이 없다. */
  snapshot(): TSnapshot {
    if (this.cached === null || this.ver === 0 || this.cached.version !== this.ver) {
      this.cached = this.buildSnapshot();
    }
    return this.cached;
  }

  /** 현재 내부 상태로 스냅샷 객체를 만든다 — version 필드는 this.ver로 채운다. */
  protected abstract buildSnapshot(): TSnapshot;
}
