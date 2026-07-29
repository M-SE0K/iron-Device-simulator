// channel-registry.ts — Electron ipcRenderer.on 방식(리스너가 채널-전역이고 start/stop 여러
// 세션을 넘어 살아있음, preload.js의 onIpc 참조)과 동등한 동작을 Tauri Channel 위에서
// 재현한다.
//
// Tauri Channel 인스턴스는 매 invoke(start()) 호출마다 새로 만들어야 하지만, 렌더러가
// onData/onE2EMark로 등록한 콜백은 세션 1회(start~stop)에 종속되지 않고 컴포넌트 생명주기를
// 따라 계속 살아있어야 한다. 그래서 콜백 구독은 모듈 스코프 레지스트리(이 클래스의 인스턴스)에
// 두고, 새 Channel의 onmessage는 매 start()마다 새로 만들어 이 레지스트리로 디스패치만
// 하도록 배선한다 — 인스턴스 자체는 audio-capture.ts/audio-playcapture.ts에서 모듈 스코프
// 상수로 한 번만 생성된다(계획서 5.7 규칙 6).
//
// 백로그: 렌더러 패턴 중 `useNativeCapture.ts`는 `await start()`가 끝난 뒤에야 onData를
// 등록한다. 그 사이 이미 도착한 첫 청크들을 잃지 않도록 유한 버퍼를 둔다 — Electron에서는
// 렌더러 이벤트 루프 큐잉이 이 간극을 흡수했으므로, 여기서는 그와 동등한 안전장치로
// 명시적 버퍼링을 쓴다. 최초 구독자 1명에게만 플러시한다(그 이후 구독자는 실시간 메시지만
// 받는다 — 렌더러가 데이터 채널을 동시에 여러 곳에서 구독하는 패턴은 없다).
const MAX_BACKLOG = 512;

export class ChannelHub<T> {
  private callbacks = new Set<(payload: T) => void>();
  private backlog: T[] = [];
  private warnedOverflow = false;

  /** 새 start() 세션을 시작할 때 호출한다 — 이전 세션에서 못 흘려보낸 백로그가 다음 세션
   *  데이터와 섞이는 걸 막는다(계획서 5.7 규칙 5 "Reset backlog on each start()"). */
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
