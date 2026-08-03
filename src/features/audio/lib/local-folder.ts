import type { LocalAudioFileEntry } from "@/shared/types/native-bridge";

export type { LocalAudioFileEntry };

export async function readLocalAudioFile(entry: LocalAudioFileEntry): Promise<File> {
  if (!window.localFolder) throw new Error("Local folder connections aren't supported in this environment.");
  const result = await window.localFolder.readFile(entry.path);
  if (!result.success || !result.data) {
    throw new Error(result.error ?? "Unable to read the file.");
  }
  return new File([result.data.slice()], entry.name, { type: result.mime, lastModified: entry.mtimeMs });
}
