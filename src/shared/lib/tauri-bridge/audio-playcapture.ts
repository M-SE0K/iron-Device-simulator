import { COMMANDS, ARG_KEYS, HEADERS, EVENTS } from "./contract";
import { safeInvoke } from "./safe-invoke";
import { syncListen } from "./sync-listen";
import { createStreamChannelPair } from "./stream-channel-pair";
import type {
  PlayCaptureStartResult,
  PlayCaptureWriteAckResult,
  PlayCaptureWriteHandshakeResult,
} from "@/shared/types/native-bridge";

const streamChannels = createStreamChannelPair();

export function createAudioPlayCaptureBridge(): NonNullable<Window["audioPlayCapture"]> {
  return {
    startWrite: (opts) =>
      safeInvoke<PlayCaptureWriteHandshakeResult>(COMMANDS.audioPlayCaptureStartWrite, {
        [ARG_KEYS.totalBytes]: opts.totalBytes,
      }),

    writeChunk: ({ writeId, chunk }) => {
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
      const { dataChannel } = streamChannels.createChannels();

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
          [ARG_KEYS.stream]: opts.stream,
          [ARG_KEYS.prefillMs]: opts.prefillMs,
        },
        [ARG_KEYS.data]: dataChannel,
      });
    },

    writePcm: (pcm) => {
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      const raw = pcm.byteOffset !== 0 || pcm.byteLength !== pcm.buffer.byteLength ? bytes.slice() : bytes;
      return safeInvoke<PlayCaptureWriteAckResult>(COMMANDS.audioPlayCaptureWritePcm, raw);
    },

    control: (action) =>
      safeInvoke<{ success: boolean; error?: string }>(COMMANDS.audioPlayCaptureControl, {
        [ARG_KEYS.action]: action,
      }),

    stop: () => safeInvoke<{ success: boolean }>(COMMANDS.audioPlayCaptureStop),

    onData: streamChannels.onData,
    onEnded: (callback) => syncListen<{ code: number | null }>(EVENTS.audioPlayCaptureEnded, callback),
  };
}
