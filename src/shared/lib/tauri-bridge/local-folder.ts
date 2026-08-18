import { invoke } from "@tauri-apps/api/core";
import { COMMANDS, ARG_KEYS, EVENTS } from "./contract";
import { safeInvoke } from "./safe-invoke";
import { syncListen } from "./sync-listen";
import { mimeForPath } from "./mime";
import type {
  LocalAudioFileEntry,
  LocalFolderReadResult,
  LocalFolderSelectResult,
} from "@/shared/types/native-bridge";

export function createLocalFolderBridge(): NonNullable<Window["localFolder"]> {
  return {
    select: async () => {
      try {
        return await invoke<LocalFolderSelectResult>(COMMANDS.localFolderSelect);
      } catch (e) {
        console.warn("[tauri-bridge] local_folder_select rejected — treating as cancel:", e);
        return { canceled: true };
      }
    },

    unwatch: () => safeInvoke<{ success: boolean }>(COMMANDS.localFolderUnwatch),

    readFile: async (filePath) => {
      try {
        const buf = await invoke<ArrayBuffer>(COMMANDS.localFolderReadFile, {
          [ARG_KEYS.path]: filePath,
        });
        return { success: true, data: new Uint8Array(buf), mime: mimeForPath(filePath) };
      } catch (e) {
        const result: LocalFolderReadResult = { success: false, error: String(e) };
        return result;
      }
    },

    onChanged: (callback) => syncListen<LocalAudioFileEntry[]>(EVENTS.localFolderChanged, callback),
  };
}
