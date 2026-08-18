import { invoke } from "@tauri-apps/api/core";
import { COMMANDS } from "./contract";

export function createWasmAssetBridge(): NonNullable<Window["wasmAsset"]> {
  return {
    loadEngineBinary: async () => {
      const buf = await invoke<ArrayBuffer>(COMMANDS.wasmAssetLoad);
      return new Uint8Array(buf);
    },
  };
}
