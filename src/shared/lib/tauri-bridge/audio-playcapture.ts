// audio-playcapture.ts — window.audioPlayCapture 브리지. 파일 재생 + 캡처
// (과거 Electron IPC 모듈 electron/ipc/audio-playcapture.js, 현재는 제거됨 → Rust
// audio_playcapture.rs)를 중계한다.
//
// startWrite/writeChunk/finalizeWrite/cancelWrite는 재생할 PCM을 4MB 청크로 나눠 미리
// 업로드하는 핸드셰이크(useNativeCapture.ts의 uploadPlaybackRef 참조) — writeChunk만
// raw invoke body를 쓴다.
//
// data/mark 레지스트리는 audio-capture.ts와 동일한 이유로 모듈 스코프, audioCapture와는
// 별개의 ChannelHub 인스턴스를 쓴다(캡처와 재생-캡처는 동시에 안 쓰이지만 브리지 자체는
// 독립적이어야 계약이 명확하다).
import { Channel } from "@tauri-apps/api/core";
import { COMMANDS, ARG_KEYS, HEADERS, EVENTS } from "./contract";
import { safeInvoke } from "./safe-invoke";
import { ChannelHub } from "./channel-registry";
import { syncListen } from "./sync-listen";
import type {
  AudioE2EMark,
  PlayCaptureStartResult,
  PlayCaptureWriteAckResult,
  PlayCaptureWriteHandshakeResult,
} from "./types";

const dataHub = new ChannelHub<Uint8Array>();
const markHub = new ChannelHub<AudioE2EMark>();

export function createAudioPlayCaptureBridge(): NonNullable<Window["audioPlayCapture"]> {
  return {
    startWrite: (opts) =>
      safeInvoke<PlayCaptureWriteHandshakeResult>(COMMANDS.audioPlayCaptureStartWrite, {
        [ARG_KEYS.totalBytes]: opts.totalBytes,
      }),

    writeChunk: ({ writeId, chunk }) => {
      // chunk는 대개 더 큰 버퍼를 가리키는 subarray 뷰(useNativeCapture.ts의
      // uploadPlaybackRef가 4MB씩 잘라 넘김) — raw body invoke는 버퍼 전체가 아니라 뷰가
      // 가리키는 바이트만 보내야 하므로, 뷰가 버퍼 전체를 덮지 않으면 slice()로 복사해
      // 정확한 바이트 범위만 전송한다.
      const raw =
        chunk.byteOffset !== 0 || chunk.byteLength !== chunk.buffer.byteLength ? chunk.slice() : chunk;
      return safeInvoke<PlayCaptureWriteAckResult>(COMMANDS.audioPlayCaptureWriteChunk, raw, {
        headers: { [HEADERS.writeId]: writeId },
      });
    },

    finalizeWrite: (opts) =>
      safeInvoke<PlayCaptureWriteAckResult>(COMMANDS.audioPlayCaptureFinalizeWrite, {
        [ARG_KEYS.writeId]: opts.writeId,
      }),

    cancelWrite: (opts) =>
      safeInvoke<PlayCaptureWriteAckResult>(COMMANDS.audioPlayCaptureCancelWrite, {
        [ARG_KEYS.writeId]: opts.writeId,
      }),

    start: async (opts) => {
      dataHub.reset();
      markHub.reset();

      const dataChannel = new Channel<ArrayBuffer>();
      dataChannel.onmessage = (buf) => dataHub.dispatch(new Uint8Array(buf));

      const markChannel = new Channel<AudioE2EMark>();
      markChannel.onmessage = (mark) => markHub.dispatch(mark);

      // Rust 시그니처: audio_playcapture_start(opts: PlayCaptureStartOptions, data, mark) —
      // 옵션은 opts 객체로 중첩, 채널 파라미터 이름은 data/mark (contract.ts 구조 규칙).
      return safeInvoke<PlayCaptureStartResult>(COMMANDS.audioPlayCaptureStart, {
        [ARG_KEYS.opts]: {
          [ARG_KEYS.sampleRate]: opts.sampleRate,
          [ARG_KEYS.bufferSize]: opts.bufferSize,
          [ARG_KEYS.channels]: opts.channels,
          [ARG_KEYS.deviceUID]: opts.deviceUID,
          [ARG_KEYS.refWriteId]: opts.refWriteId,
          [ARG_KEYS.refChannels]: opts.refChannels,
          [ARG_KEYS.outputChannel]: opts.outputChannel,
          [ARG_KEYS.outputChannelR]: opts.outputChannelR,
          [ARG_KEYS.e2e]: opts.e2e ?? false,
        },
        [ARG_KEYS.data]: dataChannel,
        [ARG_KEYS.mark]: markChannel,
      });
    },

    // "pause" | "resume" — 헬퍼 stdin 라인 명령 중계 (재생 위치 동결/재개, 캡처는 계속)
    control: (action) =>
      safeInvoke<{ success: boolean; error?: string }>(COMMANDS.audioPlayCaptureControl, {
        [ARG_KEYS.action]: action,
      }),

    stop: () => safeInvoke<{ success: boolean }>(COMMANDS.audioPlayCaptureStop),

    onData: (callback) => dataHub.subscribe(callback),
    // code 0 = 재생 완료(자기 종료), 그 외 = 비정상 종료. 사용자 stop 시에는 오지 않는다.
    onEnded: (callback) => syncListen<{ code: number | null }>(EVENTS.audioPlayCaptureEnded, callback),
    onE2EMark: (callback) => markHub.subscribe(callback),
  };
}
