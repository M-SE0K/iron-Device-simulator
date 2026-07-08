"use client";

// 로컬 폴더 연결(Electron 데스크톱 전용, window.localFolder) — WorkspaceContext가 조합하는 훅 중 하나.
// 폴더 선택/감시는 electron/main.js가 담당하고, 이 훅은 그 결과 상태만 들고 있는다.
import { useCallback, useEffect, useState } from "react";
import { readLocalAudioFile, type LocalAudioFileEntry } from "@/features/audio/lib/local-folder";

export function useLocalFolderConnection(onFileLoad: (file: File, name: string) => void) {
  const [localFolderPath, setLocalFolderPath]             = useState<string | null>(null);
  const [localFolderFiles, setLocalFolderFiles]           = useState<LocalAudioFileEntry[]>([]);
  const [localFolderError, setLocalFolderError]           = useState<string | null>(null);
  const [localFolderConnecting, setLocalFolderConnecting] = useState(false);

  // main.js가 fs.watch로 폴더 변경을 감지할 때마다 최신 파일 목록을 밀어준다.
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
      if (result.error) setLocalFolderError(result.error);
    } finally {
      setLocalFolderConnecting(false);
    }
  }, []);

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
      setLocalFolderError(err instanceof Error ? err.message : "파일을 불러올 수 없습니다.");
    }
  }, [onFileLoad]);

  return {
    localFolderPath, localFolderFiles, localFolderError, localFolderConnecting,
    connectLocalFolder, disconnectLocalFolder, loadLocalFile,
  };
}
