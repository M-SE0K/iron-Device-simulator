import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

/**
 * 스토어에서 "React 상태로 들고 있어야 하는 값"(헤더 현재값·peak/rms 배지)을 읽는 공통
 * 주기(ms). 그래프 자체는 source 경로로 React를 거치지 않고 커밋되므로, 스토어 갱신
 * 빈도(초당 100회 이상)와 무관하게 리렌더는 이 주기로만 일어난다.
 */
export const READOUT_INTERVAL_MS = 100;

interface VersionedSnapshot {
  version: number;
}

interface SnapshotStore<TSnapshot extends VersionedSnapshot> {
  snapshot: () => TSnapshot;
  subscribe: (callback: () => void) => () => void;
}

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
