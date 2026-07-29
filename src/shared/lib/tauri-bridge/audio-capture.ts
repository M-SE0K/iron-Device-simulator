// audio-capture.ts — window.audioCapture 브리지. mic 캡처 스트리밍(electron/ipc/
// audio-capture.js → Rust audio_capture.rs)을 Tauri Channel로 중계한다.
//
// data/mark 콜백 레지스트리(ChannelHub)는 모듈 스코프에 두어 여러 start/stop 세션에 걸쳐
// 살아있게 한다 — Electron의 ipcRenderer.on이 헬퍼 재시작과 무관하게 리스너를 유지하던
// 것과 동일한 의미(계획서 5.7 규칙 6). Channel 인스턴스 자체는 start()마다 새로 만든다.
import { Channel } from "@tauri-apps/api/core";
import { COMMANDS, ARG_KEYS, EVENTS } from "./contract";
import { safeInvoke } from "./safe-invoke";
import { ChannelHub } from "./channel-registry";
import { syncListen } from "./sync-listen";
import type { AudioCaptureStartResult, AudioE2EMark } from "./types";

const dataHub = new ChannelHub<Uint8Array>();
const markHub = new ChannelHub<AudioE2EMark>();

export function createAudioCaptureBridge(): NonNullable<Window["audioCapture"]> {
  return {
    start: async (opts) => {
      // 새 세션 — 이전 세션의 미소비 백로그를 버린다.
      dataHub.reset();
      markHub.reset();

      // Rust InvokeResponseBody::Raw로 보낸 바이너리는 ArrayBuffer로 도착한다(계획서 5.0
      // 스파이크로 검증됨) — Uint8Array로 감싸 onData 계약(Uint8Array 인자)을 만족시킨다.
      const dataChannel = new Channel<ArrayBuffer>();
      dataChannel.onmessage = (buf) => dataHub.dispatch(new Uint8Array(buf));

      // e2e:false여도 항상 만들어 함께 넘긴다 — Rust가 e2e일 때만 실제로 메시지를 보낸다
      // (계획서 5.7 규칙 7 / contract.ts COMMAND_ARGS 주석 참조).
      const markChannel = new Channel<AudioE2EMark>();
      markChannel.onmessage = (mark) => markHub.dispatch(mark);

      // Rust 시그니처: audio_capture_start(opts: CaptureStartOptions, data, mark) —
      // 옵션은 opts 객체로 중첩, 채널 파라미터 이름은 data/mark (contract.ts 구조 규칙).
      return safeInvoke<AudioCaptureStartResult>(COMMANDS.audioCaptureStart, {
        [ARG_KEYS.opts]: {
          [ARG_KEYS.sampleRate]: opts.sampleRate,
          [ARG_KEYS.bufferSize]: opts.bufferSize,
          [ARG_KEYS.channels]: opts.channels,
          [ARG_KEYS.deviceUID]: opts.deviceUID,
          [ARG_KEYS.e2e]: opts.e2e ?? false,
        },
        [ARG_KEYS.data]: dataChannel,
        [ARG_KEYS.mark]: markChannel,
      });
    },

    stop: () => safeInvoke<{ success: boolean }>(COMMANDS.audioCaptureStop),

    onData: (callback) => dataHub.subscribe(callback),
    onEnded: (callback) => syncListen<{ code: number | null }>(EVENTS.audioCaptureEnded, callback),
    // start({ e2e: true })일 때만 실제로 값이 온다 — E2E 지연 실험(N1) 전용.
    onE2EMark: (callback) => markHub.subscribe(callback),
  };
}
