import { COMMANDS, ARG_KEYS, EVENTS } from "./contract";
import { safeInvoke } from "./safe-invoke";
import { syncListen } from "./sync-listen";
import { createStreamChannelPair } from "./stream-channel-pair";
import type { AudioCaptureStartResult } from "@/shared/types/native-bridge";

const streamChannels = createStreamChannelPair();

export function createAudioCaptureBridge(): NonNullable<Window["audioCapture"]> {
  return {
    start: async (opts) => {
      const { dataChannel } = streamChannels.createChannels();

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
