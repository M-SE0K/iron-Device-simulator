/**
 * 짧게 메인 스레드를 양보한다. `scheduler.yield()`가 있으면 우선순위를 유지한 채 양보하고
 * (지원 브라우저 한정), 없으면 MessageChannel로 매크로태스크 경계를 만든다.
 *
 * 마이크로태스크(`await Promise.resolve()`)나 `setTimeout(0)`은 쓰지 않는다 — 전자는 같은
 * 태스크 안에서 소진돼 다른 콜백(예: IPC 캡처 청크)에 순서를 넘기지 못하고, 후자는 중첩
 * 타이머에 4ms 클램프가 붙어 필요 이상으로 느려진다.
 */
export function yieldToMain(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (s?.yield) return s.yield();
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}
