"use client";

import { useCallback, useState } from "react";

export function useBrowserFolderUpload(onFileLoad: (file: File, name: string) => void) {
  const [browserFolderName, setBrowserFolderName]   = useState<string | null>(null);
  const [browserFolderFiles, setBrowserFolderFiles] = useState<File[]>([]);

  const selectBrowserFolder = useCallback((files: FileList | File[]) => {
    const all = Array.from(files);
    const folder = all[0]?.webkitRelativePath?.split("/")[0] || "Folder";
    const audio = all.filter(
      (f) => f.type.startsWith("audio/") || /\.(wav|mp3|flac|aac|m4a|ogg)$/i.test(f.name),
    );
    setBrowserFolderName(folder);
    setBrowserFolderFiles(audio);
  }, []);

  const disconnectBrowserFolder = useCallback(() => {
    setBrowserFolderName(null);
    setBrowserFolderFiles([]);
  }, []);

  const loadBrowserFile = useCallback((file: File) => {
    onFileLoad(file, file.name);
  }, [onFileLoad]);

  return { browserFolderName, browserFolderFiles, selectBrowserFolder, disconnectBrowserFolder, loadBrowserFile };
}
