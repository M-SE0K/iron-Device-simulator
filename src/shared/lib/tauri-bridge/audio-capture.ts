// audio-capture.ts — window.audioCapture 브리지. mic 캡처 스트리밍(Rust audio_capture.rs)을
// Tauri Channel로 중계한다.
//
// data 콜백 레지스트리(ChannelHub)는 모듈 스코프에 두어 여러 start/stop 세션에 걸쳐
// 헬퍼 재시작과 무관하게 리스너가 계속 살아있게 한다(계획서 5.7 규칙 6). Channel 인스턴스
// 자체는 start()마다 새로 만든다.
import { COMMANDS, ARG_KEYS, EVENTS } from "./contract";
import { safeInvoke } from "./safe-invoke";
import { syncListen } from "./sync-listen";
import { createStreamChannelPair } from "./stream-channel-pair";
import type { AudioCaptureStartResult } from "@/shared/types/native-bridge";

const streamChannels = createStreamChannelPair();

export function createAudioCaptureBridge(): NonNullable<Window["audioCapture"]> {
  return {
    start: async (opts) => {
      // Rust InvokeResponseBody::Raw로 보낸 바이너리는 ArrayBuffer로 도착한다(계획서 5.0
      // 스파이크로 검증됨) — Uint8Array로 감싸 onData 계약(Uint8Array 인자)을 만족시킨다.
      const { dataChannel } = streamChannels.createChannels();

      // Rust 시그니처: audio_capture_start(opts: CaptureStartOptions, data) —
      // 옵션은 opts 객체로 중첩, 채널 파라미터 이름은 data (contract.ts 구조 규칙).
      return safeInvoke<AudioCaptureStartResult>(COMMANDS.audioCaptureStart, {
        [ARG_KEYS.opts]: {
          [ARG_KEYS.sampleRate]: opts.sampleRate,
          [ARG_KEYS.bufferSize]: opts.bufferSize,
          [ARG_KEYS.channels]: opts.channels,
          [ARG_KEYS.deviceUID]: opts.deviceUID,
        },
        [ARG_KEYS.data]: dataChannel,
      });
    },

    stop: () => safeInvoke<{ success: boolean }>(COMMANDS.audioCaptureStop),

    onData: streamChannels.onData,
    onEnded: (callback) => syncListen<{ code: number | null }>(EVENTS.audioCaptureEnded, callback),
  };
}
