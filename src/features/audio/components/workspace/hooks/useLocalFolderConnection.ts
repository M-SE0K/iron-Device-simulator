"use client";

import { useCallback, useEffect, useState } from "react";
import { readLocalAudioFile, type LocalAudioFileEntry } from "@/features/audio/lib/local-folder";
import { useErrorPopup } from "@/shared/components/error-popup/ErrorPopupContext";
import { humanizeIpcError } from "@/shared/lib/ipc-error";

export function useLocalFolderConnection(onFileLoad: (file: File, name: string) => void) {
  const { showError } = useErrorPopup();
  const [localFolderPath, setLocalFolderPath]             = useState<string | null>(null);
  const [localFolderFiles, setLocalFolderFiles]           = useState<LocalAudioFileEntry[]>([]);
  const [localFolderError, setLocalFolderError]           = useState<string | null>(null);
  const [localFolderConnecting, setLocalFolderConnecting] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.localFolder) return;
    return window.localFolder.onChanged((files) => setLocalFolderFiles(files));
  }, []);

  const connectLocalFolder = useCallback(async () => {
    if (typeof window === "undefined" || !window.localFolder) return;
    setLocalFolderConnecting(true);
    setLocalFolderError(null);
    try {
      const result = await window.localFolder.select();
      if (result.canceled) return;
      setLocalFolderPath(result.folderPath ?? null);
      setLocalFolderFiles(result.files ?? []);
      if (result.error) {
        const message = humanizeIpcError(result.error, "Failed to scan the folder for audio files.");
        setLocalFolderError(message);
        showError(message);
      }
    } finally {
      setLocalFolderConnecting(false);
    }
  }, [showError]);

  const disconnectLocalFolder = useCallback(() => {
    if (typeof window !== "undefined" && window.localFolder) void window.localFolder.unwatch();
    setLocalFolderPath(null);
    setLocalFolderFiles([]);
    setLocalFolderError(null);
  }, []);

  const loadLocalFile = useCallback(async (entry: LocalAudioFileEntry) => {
    try {
      const file = await readLocalAudioFile(entry);
      onFileLoad(file, entry.name);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const message = humanizeIpcError(raw, "Failed to load file.");
      setLocalFolderError(message);
      showError(message);
    }
  }, [onFileLoad, showError]);

  return {
    localFolderPath, localFolderFiles, localFolderError, localFolderConnecting,
    connectLocalFolder, disconnectLocalFolder, loadLocalFile,
  };
}
