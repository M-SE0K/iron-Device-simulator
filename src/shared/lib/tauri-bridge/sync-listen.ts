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
