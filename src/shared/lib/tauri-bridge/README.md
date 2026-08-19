# tauri-bridge

## 1. 도메인 설명

Tauri의 IPC(`invoke`/`Channel`/이벤트)를 Electron 시절과 똑같은 `window.audioDevice`/`audioCapture`/`audioPlayCapture`/`localFolder`/`wasmAsset` 전역 모양으로 감싸는 shim 계층입니다. 나머지 앱 코드는 데스크톱 셸이 Tauri라는 사실도, IPC 동작 방식도 몰라도 됩니다.

## 2. 프로젝트 전반에서의 역할

`installTauriBridge()`는 Tauri 런타임, 곧 `window.__TAURI_INTERNALS__`가 있을 때만 이 전역 5개를 채웁니다. 각 브리지 파일은 대응하는 Rust 커맨드를 그대로 호출만 합니다. 계약(커맨드 이름·인자 키·헤더·이벤트 이름)은 `contract.ts` 한 곳에 모아 `src-tauri/`의 Rust 코드와 나란히 유지합니다. 여러 브리지가 똑같이 겪는 문제는 `safe-invoke.ts`/`sync-listen.ts`/`channel-registry.ts`/`stream-channel-pair.ts`가 공용으로 풉니다. 에러 반환 규약, 동기 unsubscribe, 세션 경계를 넘는 리스너 유지, Tauri `Channel` → 구독자 중계 배선 네 가지입니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `index.ts` | `installTauriBridge()` — 5개 전역을 한 번만 설치하는 진입점 |
| `contract.ts` | `COMMANDS`/`ARG_KEYS`/`HEADERS`/`EVENTS` — Rust 커맨드 이름·인자 키·헤더·이벤트 이름의 단일 소스 |
| `safe-invoke.ts` | `invoke()` 실패(reject)를 `{success:false, error}` 반환값으로 정규화하는 `safeInvoke()` |
| `sync-listen.ts` | Tauri `listen()`의 비동기 결과를 동기 unsubscribe 함수로 감싸는 `syncListen()` |
| `channel-registry.ts` | `ChannelHub` — 세션(start~stop) 경계를 넘어 살아있는 콜백 레지스트리, 구독자 없을 때 백로그 버퍼링(최대 512개, 넘치면 가장 오래된 것부터 폐기 + 1회 경고) |
| `stream-channel-pair.ts` | `createStreamChannelPair()` — 세션마다 새 `Channel<ArrayBuffer>`를 만들어 `ChannelHub<Uint8Array>`로 중계하는 공용 배선. `audio-capture`/`audio-playcapture`가 공유 |
| `mime.ts` | 파일 확장자 → MIME 타입 매핑 `mimeForPath()` |
| `audio-device.ts` | `window.audioDevice` 구현 — `list`/`query` 두 커맨드만 남음 |
| `audio-capture.ts` | `window.audioCapture` 구현 — `data` Channel 하나로 PCM 청크를 중계하고 종료는 `onEnded` 이벤트로 받음 |
| `audio-playcapture.ts` | `window.audioPlayCapture` 구현 — 재생 PCM 업로드 핸드셰이크(`--ref` 파일 모드) + `writePcm()` 스트림 모드(Protected playback) + data 스트림 중계 |
| `local-folder.ts` | `window.localFolder` 구현 |
| `file-export.ts` | Tauri 전용 저장 다이얼로그 우회 커맨드 `saveFileViaTauri()` |
| `wasm-asset.ts` | `window.wasmAsset` 구현 — `wasm_asset_load` 커맨드(`src-tauri/src/wasm_asset.rs`)를 불러 암호화 배포된 WASM 바이너리를 `Uint8Array`로 받음 |

## 4. 의존성 및 흐름

- **가져오는 것**: `@tauri-apps/api/core`(`invoke`, `Channel`), `@tauri-apps/api/event`(`listen`), `@/shared/types/native-bridge`. 결과 타입(`AudioCaptureStartResult` 등)은 `native-bridge.d.ts`가 직접 export하는 것을 그대로 가져다 씁니다 — shim 내부용 미러 타입 파일(`types.ts`)은 삭제됐습니다.
- **`src-tauri/`와의 접점**: 이 도메인은 전체가 Rust `#[tauri::command]` 커맨드와 1:1로 맞물리는 계약을 구현합니다. 그 계약의 기준은 `contract.ts` 하나뿐입니다. `wasm-asset.ts`의 상대는 `src-tauri/src/wasm_asset.rs`로, 배포 빌드에서는 `ff_prot.wasm.enc`를 AES-256-GCM으로 복호화해 돌려주고 `--dev`(`plain-wasm` 피처) 빌드만 평문 리소스 폴백을 컴파일에 포함합니다.
- **소비하는 쪽**: `installTauriBridge()`는 `src/app/TauriBridgeInit.tsx`가 모듈 스코프에서 호출합니다. 그다음부터 `features/audio`의 `useNativeCapture.ts`/`useNativeAudioDevice.ts`/`lib/local-folder.ts` 등은 `window.audioDevice` 같은 전역으로만 이 도메인을 간접적으로 씁니다(직접 import 없음). 다만 `shared/lib/utils.ts`의 `downloadBlob()`은 `file-export.ts`의 `saveFileViaTauri()`를 직접 호출하고 `engine/protocol/engine-client.ts`는 `window.wasmAsset`을 직접 참조합니다.

```
src/app/TauriBridgeInit.tsx(모듈 스코프, React 마운트 전) → installTauriBridge()
  __TAURI_INTERNALS__ 존재 확인
  → window.audioDevice / audioCapture / audioPlayCapture / localFolder / wasmAsset 설치

호출부(예: useNativeCapture.ts) → window.audioCapture.start(opts)
  → createStreamChannelPair().createChannels()가 dataHub.reset() 후 새 Channel<ArrayBuffer> 생성
  → safeInvoke("audio_capture_start", { opts, data: Channel })
  → Rust audio_capture.rs가 Channel로 청크 스트리밍 → dataHub.dispatch(Uint8Array) → onData 구독자에게 전달
  → 헬퍼 종료는 "audio-capture:ended" 이벤트 → onEnded(syncListen) 콜백

Protected playback 스트림 모드: start({stream:true, prefillMs}) 후 매 프레임 writePcm(Int16Array)
  → 바이트가 invoke 본문(raw payload)으로 넘어가고, 파일 모드 청크 업로드는 x-write-id 헤더로 세션을 식별
```

## 5. 주요 인터페이스 / 진입점

- **`installTauriBridge(): void`** — 이 도메인의 유일한 외부 진입점. 이미 설치됐거나 Tauri 런타임이 아니면 아무것도 하지 않습니다.
- **`COMMANDS` / `ARG_KEYS` / `HEADERS` / `EVENTS`**(`contract.ts`) — Rust 계약을 담은 상수. 새 커맨드/이벤트를 추가할 때 반드시 여기부터 등록합니다. 오디오 장치 get/set 커맨드는 제거됐고 `audio_playcapture_write_pcm`/`wasm_asset_load`가 들어왔습니다.
- **`safeInvoke<T extends {success, error?}>(cmd, args?, options?): Promise<T>`** — `{success, error}` 반환 규약을 쓰는 커맨드 전용입니다. `options`(`InvokeOptions`)로 헤더를 실어 보낼 수 있습니다(`writeChunk`의 `x-write-id`). `local_folder_select`/`local_folder_read_file`처럼 규약이 다른 커맨드에는 쓰지 않습니다.
- **`syncListen<T>(event, handler): () => void`** — 동기 unsubscribe 함수를 돌려줍니다. `useEffect` cleanup에 그대로 리턴하면 됩니다.
- **`class ChannelHub<T>`** — `reset()`(새 세션 시작 시 백로그 정리) / `dispatch(payload)` / `subscribe(cb): () => void`. 구독자가 없으면 최대 512개까지 백로그에 쌓았다가 첫 구독자에게 몰아서 flush합니다.
- **`createStreamChannelPair(): { createChannels, onData }`** — 세션마다 `createChannels()`로 새 `Channel<ArrayBuffer>`를 받아 invoke 인자로 넘기고 `onData(cb)` 구독은 세션 경계와 무관하게 유지되는 공용 스트림 배선.
- **`saveFileViaTauri(blob: Blob, filename: string): Promise<void>`** — 임시 파일을 쓰고 저장 다이얼로그를 여는 2단계 invoke.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — `src/shared/` 도메인에서 분리해 신설했습니다. WASM 암호화 배포용 `wasm-asset.ts`(`window.wasmAsset`)가 이미 들어와 있는 상태까지 반영했습니다(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함).
- 2026-08-19: 공용 스트림 배선 `stream-channel-pair.ts` 신설(캡처/재생 브리지가 공유, mark 채널 없이 data 단일 Channel + `onEnded` 이벤트 구조)과 내부 미러 타입 `types.ts` 삭제(결과 타입은 `native-bridge.d.ts`가 직접 export)를 반영. `audio-device.ts`는 `list`/`query`만 남았고, Protected playback용 `writePcm()`/`stream`/`prefillMs`와 `control("end")`가 `audio-playcapture.ts`에 들어왔습니다. `wasm-asset.ts` ↔ `src-tauri/src/wasm_asset.rs`(AES-256-GCM 복호화, `plain-wasm` 피처 폴백) 짝도 명시. 섹션 2~5 부분 갱신 (커밋 범위: 4d86f32..24d1daa)
