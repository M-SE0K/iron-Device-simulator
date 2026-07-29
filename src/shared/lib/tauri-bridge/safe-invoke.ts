// safe-invoke.ts — Electron IPC 규약("에러는 예외가 아니라 {success:false, error} 반환값",
// 계획서 2번)을 Tauri invoke 위에서 재현한다. Rust 커맨드가 Err를 반환하면 Tauri invoke는
// Promise를 reject하는데, 이 래퍼가 그 reject를 catch해 동일한 반환값 규약으로 바꿔준다.
//
// {success, ...} 형태의 결과를 리턴하는 커맨드에만 쓴다(audioDevice 4종, audioCapture/
// audioPlayCapture의 start/stop/startWrite/writeChunk/finalizeWrite/cancelWrite/control,
// localFolder.unwatch). local_folder_select(취소=성공 규약이 달라 별도 처리)와
// local_folder_read_file(원래도 예외로 reject하는 게 맞는 계약)은 이 래퍼를 쓰지 않는다.
import { invoke } from "@tauri-apps/api/core";
import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";

export async function safeInvoke<T extends { success: boolean; error?: string }>(
  cmd: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  try {
    return await invoke<T>(cmd, args, options);
  } catch (e) {
    return { success: false, error: String(e) } as T;
  }
}
