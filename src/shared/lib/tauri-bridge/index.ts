// index.ts — installTauriBridge(): Tauri 데스크톱 런타임에서만 window.audioDevice/
// audioCapture/audioPlayCapture/localFolder/wasmAsset 5개 전역을 채운다(과거 Electron IPC
// 시절 electron/preload.js가 contextBridge로 하던 일의 TS 등가물 — 그 파일은 현재 제거됨).
//
// 각 기능은 자신이 사용하는 브리지 전역의 존재 여부로 가용성을 판단하고(userAgent 스니핑 없음),
// UI 가용성 감지 일부는 hydration 이후 useEffect에서 하고, 실제 캡처·WASM·파일 호출 경로도
// 호출 시점에 해당 window.* 전역을 확인한다. 그래서 이 함수가 "React 마운트보다
// 먼저" 실행되기만 하면 되고, src/app/TauriBridgeInit.tsx가 모듈 스코프(컴포넌트 렌더 이전,
// import 시점)에서 동기 호출한다.
//
// 일반 브라우저/정적 프리뷰에서는 브리지를 설치하지 않으며 네이티브 캡처·폴더 기능은 사용할 수 없다.
import { createAudioDeviceBridge } from "./audio-device";
import { createAudioCaptureBridge } from "./audio-capture";
import { createAudioPlayCaptureBridge } from "./audio-playcapture";
import { createLocalFolderBridge } from "./local-folder";
import { createWasmAssetBridge } from "./wasm-asset";

let installed = false;

export function installTauriBridge(): void {
  if (installed) return;
  // Next 정적 export는 layout을 서버(Node)에서도 한 번 렌더링한다 — window가 없는 그 경로를
  // 여기서 걸러낸다. 컴포넌트 자체(TauriBridgeInit.tsx)는 렌더 시점에 window를 참조하지
  // 않으므로 SSR은 안전하고, 이 가드는 모듈 스코프 호출을 위한 것이다.
  if (typeof window === "undefined") return;
  if (!("__TAURI_INTERNALS__" in window)) return;

  installed = true;
  window.audioDevice = createAudioDeviceBridge();
  window.audioCapture = createAudioCaptureBridge();
  window.audioPlayCapture = createAudioPlayCaptureBridge();
  window.localFolder = createLocalFolderBridge();
  window.wasmAsset = createWasmAssetBridge();
}
