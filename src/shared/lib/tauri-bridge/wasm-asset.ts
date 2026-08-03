// wasm-asset.ts — window.wasmAsset 브리지 (WASM 알고리즘 암호화 배포, 방법 5).
// src-tauri/src/wasm_asset.rs가 암호화된 ff_prot.wasm.enc를 메모리에서 복호화해 raw
// bytes(tauri::ipc::Response, JSON 아님)로 돌려준다 — local-folder.ts의 readFile과 동일하게
// safeInvoke가 아니라 invoke를 직접 쓰고 여기서 catch한다.
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
