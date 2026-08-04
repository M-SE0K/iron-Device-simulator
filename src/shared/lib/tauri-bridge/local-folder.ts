// local-folder.ts — window.localFolder 브리지 (과거 Electron IPC 모듈 electron/ipc/local-folder.js,
// 현재는 제거됨 → Rust local_folder.rs로 포팅). 네이티브 오디오 헬퍼가 미지원인 Linux에서도
// 동작하는 크로스플랫폼 폴더 브리지.
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
        // Electron 원본 local-folder:select는 절대 reject하지 않는다 — 사용자가 다이얼로그를
        // 취소하면 {canceled:true}, 스캔이 실패해도 {canceled:false, folderPath, files:[],
        // error}로 resolve한다(원본 다이얼로그 자체의 실패는 일어나지 않았기 때문). Rust
        // 커맨드가 예상 밖으로 reject하면 폴더 경로를 모르는 상태이므로 files:[]/folderPath
        // 를 지어낼 수 없다 — 가장 안전한 UI 상태인 "취소"와 동등하게 처리하고 콘솔에만
        // 원인을 남긴다(계획서 5.7 규칙 — 이 shim의 pragmatic 선택, REPORT에 기록).
        console.warn("[tauri-bridge] local_folder_select rejected — treating as cancel:", e);
        return { canceled: true };
      }
    },

    unwatch: () => safeInvoke<{ success: boolean }>(COMMANDS.localFolderUnwatch),

    readFile: async (filePath) => {
      try {
        // Rust local_folder_read_file은 실패 시 Err(String)으로 reject하고, 성공 시
        // tauri::ipc::Response::new(bytes)로 raw 응답(ArrayBuffer)을 준다 — JSON이 아니므로
        // safeInvoke가 아니라 invoke를 직접 쓰고 여기서 catch한다.
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
