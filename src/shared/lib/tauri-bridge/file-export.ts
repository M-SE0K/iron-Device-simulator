import { invoke } from "@tauri-apps/api/core";
import { COMMANDS, ARG_KEYS } from "./contract";

export async function saveFileViaTauri(blob: Blob, filename: string): Promise<void> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { tempPath } = await invoke<{ tempPath: string }>(COMMANDS.fileExportWriteTemp, bytes);
  await invoke(COMMANDS.fileExportSave, {
    [ARG_KEYS.tempPath]: tempPath,
    [ARG_KEYS.filename]: filename,
  });
}
