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
