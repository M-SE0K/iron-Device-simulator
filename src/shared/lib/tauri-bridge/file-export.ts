// file-export.ts — Tauri 전용 파일 저장 우회로. blob + `<a download>` 앵커 다운로드가
// Tauri 네이티브 웹뷰(특히 macOS WKWebView)에서 저장 다이얼로그를 띄우지 못하는 문제 때문에
// 추가됐다 — 일반 브라우저는 downloadBlob()의 앵커 다운로드로 충분하다. `shared/lib/download.ts`의
// downloadBlob()이 Tauri 런타임을 감지하면 이 함수로 위임한다.
//
// 두 단계로 나눠 invoke한다(file_export.rs 참고 — raw body를 받는 write_temp는 sync 커맨드라야
// 하고, 저장 다이얼로그를 여는 save는 반드시 async 커맨드라야 해서 하나로 합칠 수 없다):
//   1. write_temp: 바이트를 임시 파일에 쓰고 tempPath를 받는다.
//   2. save: tempPath + filename으로 저장 다이얼로그를 열고 최종 위치로 옮긴다.
//
// 반환값의 success/error 규약(safeInvoke)이 아니라 canceled 규약(local_folder_select와
// 동일)이라 safeInvoke를 쓰지 않는다 — Rust가 실제 I/O 에러일 때만 reject하고, 그 외에는
// 항상 {canceled} 형태로 resolve한다. 사용자가 저장 다이얼로그를 취소한 경우는 에러가
// 아니므로 그냥 조용히 반환한다.
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
