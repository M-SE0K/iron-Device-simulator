// local-folder.ts — window.localFolder(Electron preload) 브리지를 다루는 얇은 헬퍼.
// 브라우저/모바일 빌드에서는 window.localFolder가 없으므로 isLocalFolderBridgeAvailable()로
// 먼저 감지한다 (Electron 데스크톱 전용 기능 — CalibrationDrawer의 audioDevice 감지 패턴과 동일).
import type { LocalAudioFileEntry } from "@/shared/types/electron-bridge";

export type { LocalAudioFileEntry };

export function isLocalFolderBridgeAvailable(): boolean {
  return typeof window !== "undefined" && !!window.localFolder;
}

export async function readLocalAudioFile(entry: LocalAudioFileEntry): Promise<File> {
  if (!window.localFolder) throw new Error("이 환경에서는 로컬 폴더 연결을 지원하지 않습니다.");
  const result = await window.localFolder.readFile(entry.path);
  if (!result.success || !result.data) {
    throw new Error(result.error ?? "파일을 읽을 수 없습니다.");
  }
  return new File([result.data.slice()], entry.name, { type: result.mime, lastModified: entry.mtimeMs });
}
