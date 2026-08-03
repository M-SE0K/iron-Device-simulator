// sync-listen.ts — Tauri `listen()`은 Promise<UnlistenFn>을 반환하는 비동기 API지만,
// 렌더러 계약(onEnded/onChanged, native-bridge.d.ts)은 **동기적으로** unsubscribe 함수를
// 반환해야 한다(계획서 5.7 규칙 1 — useLocalFolderConnection.ts:17이 반환값을 useEffect
// cleanup으로 직접 리턴하는 등, 동기 함수를 기대하는 소비처가 있다).
//
// listen()의 Promise를 내부에 들고 있다가 resolve되면 그때 unlisten을 호출하는 방식으로
// 감싼다. `active` 플래그로, unsubscribe가 listen() resolve보다 먼저 호출되는 경쟁 상황
// (컴포넌트가 mount 직후 바로 unmount되는 경우 등)에서도 이후 도착하는 이벤트가 핸들러를
// 트리거하지 않도록 막는다 — resolve 시점에 실제 unlisten()도 호출해 리스너 자체를 정리한다.
import { listen } from "@tauri-apps/api/event";

export function syncListen<T>(event: string, handler: (payload: T) => void): () => void {
  let active = true;
  const unlistenPromise = listen<T>(event, (e) => {
    if (active) handler(e.payload);
  });
  return () => {
    active = false;
    void unlistenPromise.then((unlisten) => unlisten());
  };
}
