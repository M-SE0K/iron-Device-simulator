import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

interface VersionedSnapshot {
  version: number;
}

interface SnapshotStore<TSnapshot extends VersionedSnapshot> {
  snapshot: () => TSnapshot;
  subscribe: (callback: () => void) => () => void;
}

/** 스토어 readout을 React 상태로 가져오는 기본 갱신 주기(ms). */
export const DEFAULT_STORE_READOUT_INTERVAL_MS = 100;

export function useThrottledStoreSnapshot<TSnapshot extends VersionedSnapshot, TSelected>(
  store: SnapshotStore<TSnapshot>,
  selector: (snapshot: TSnapshot) => TSelected,
  isEqual: (previous: TSelected, next: TSelected) => boolean,
  intervalMs: number,
): [TSelected, Dispatch<SetStateAction<TSelected>>] {
  const [selected, setSelected] = useState(() => selector(store.snapshot()));

  useEffect(() => {
    let timer: number | null = null;
    let lastVersion = -1;

    const sync = () => {
      timer = null;
      const snapshot = store.snapshot();
      if (snapshot.version === lastVersion) return;
      lastVersion = snapshot.version;
      const next = selector(snapshot);
      setSelected((previous) => (isEqual(previous, next) ? previous : next));
    };

    const onUpdate = () => {
      if (timer === null) timer = window.setTimeout(sync, intervalMs);
    };

    const unsubscribe = store.subscribe(onUpdate);
    sync();
    return () => {
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [store, selector, isEqual, intervalMs]);

  return [selected, setSelected];
}
