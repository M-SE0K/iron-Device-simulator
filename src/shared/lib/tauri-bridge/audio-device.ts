import { COMMANDS, ARG_KEYS } from "./contract";
import { safeInvoke } from "./safe-invoke";
import type {
  AudioDeviceListResult,
  AudioDeviceQueryResult,
} from "@/shared/types/native-bridge";

export function createAudioDeviceBridge(): NonNullable<Window["audioDevice"]> {
  return {
    list: () => safeInvoke<AudioDeviceListResult>(COMMANDS.audioDeviceList),

    query: (deviceUID) =>
      safeInvoke<AudioDeviceQueryResult>(COMMANDS.audioDeviceQuery, {
        [ARG_KEYS.opts]: { [ARG_KEYS.deviceUID]: deviceUID },
      }),
  };
}
