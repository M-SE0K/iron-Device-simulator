"use client";

// 브라우저(웹/모바일) 폴더 업로드(<input webkitdirectory>) — WorkspaceContext가 조합하는 훅 중 하나.
// Electron localFolder가 없는 빌드에서 같은 "폴더에서 파일 고르기" UX를 제공한다.
import { useCallback, useState } from "react";

export function useBrowserFolderUpload(onFileLoad: (file: File, name: string) => void) {
  const [browserFolderName, setBrowserFolderName]   = useState<string | null>(null);
  const [browserFolderFiles, setBrowserFolderFiles] = useState<File[]>([]);

  const selectBrowserFolder = useCallback((files: FileList | File[]) => {
    const all = Array.from(files);
    // webkitRelativePath 는 "폴더/하위/파일.wav" 형태 — 최상위 폴더 이름을 뽑는다.
    const folder = all[0]?.webkitRelativePath?.split("/")[0] || "폴더";
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
    onFileLoad(file, file.name); // File 을 그대로 업로드 파이프라인으로 전달
  }, [onFileLoad]);

  return { browserFolderName, browserFolderFiles, selectBrowserFolder, disconnectBrowserFolder, loadBrowserFile };
}
