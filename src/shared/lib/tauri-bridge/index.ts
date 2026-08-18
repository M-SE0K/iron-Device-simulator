import { createAudioDeviceBridge } from "./audio-device";
import { createAudioCaptureBridge } from "./audio-capture";
import { createAudioPlayCaptureBridge } from "./audio-playcapture";
import { createLocalFolderBridge } from "./local-folder";
import { createWasmAssetBridge } from "./wasm-asset";

let installed = false;

export function installTauriBridge(): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  if (!("__TAURI_INTERNALS__" in window)) return;

  installed = true;
  window.audioDevice = createAudioDeviceBridge();
  window.audioCapture = createAudioCaptureBridge();
  window.audioPlayCapture = createAudioPlayCaptureBridge();
  window.localFolder = createLocalFolderBridge();
  window.wasmAsset = createWasmAssetBridge();
}
