# tauri-bridge

## 1. 도메인 설명

Tauri의 IPC(`invoke`/`Channel`/이벤트)를 Electron 시절과 똑같은 `window.audioDevice`/`audioCapture`/`audioPlayCapture`/`localFolder`/`wasmAsset` 전역 모양으로 감싸는 shim 계층입니다. 나머지 앱 코드는 데스크톱 셸이 Tauri라는 사실도, IPC 동작 방식도 몰라도 됩니다.

## 2. 프로젝트 전반에서의 역할

`installTauriBridge()`는 Tauri 런타임, 곧 `window.__TAURI_INTERNALS__`가 있을 때만 이 전역 5개를 채웁니다. 각 브리지 파일은 대응하는 Rust 커맨드를 그대로 호출만 합니다. 계약(커맨드 이름·인자 키·이벤트 이름)은 `contract.ts` 한 곳에 모아 `src-tauri/`의 Rust 코드와 나란히 유지합니다. 여러 브리지가 똑같이 겪는 문제는 공용 모듈이 풉니다. `safe-invoke.ts`는 에러 반환 규약을, `sync-listen.ts`는 동기 unsubscribe를, `channel-registry.ts`는 세션 경계를 넘는 리스너 유지를 맡습니다. `stream-channel-pair.ts`는 그 레지스트리와 매 세션 새로 만드는 `Channel`을 배선합니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `index.ts` | `installTauriBridge()` — 5개 전역을 한 번만 설치하는 진입점 |
| `contract.ts` | `COMMANDS`/`ARG_KEYS`/`HEADERS`/`EVENTS` — Rust 커맨드 이름·인자 키·이벤트 이름의 단일 소스 |
| `safe-invoke.ts` | `invoke()` 실패(reject)를 `{success:false, error}` 반환값으로 정규화하는 `safeInvoke()` |
| `sync-listen.ts` | Tauri `listen()`의 비동기 결과를 동기 unsubscribe 함수로 감싸는 `syncListen()` |
| `channel-registry.ts` | `ChannelHub` — 세션(start~stop) 경계를 넘어 살아있는 콜백 레지스트리, 구독자 없을 때 백로그 버퍼링(최대 512개, 넘치면 오래된 것부터 버리며 한 번만 경고) |
| `stream-channel-pair.ts` | `createStreamChannelPair()` — `ChannelHub` 하나 + `start()`마다 새로 만드는 `Channel`을 묶어 `onData` 구독 표면으로 내주는 팩토리. 캡처와 재생-캡처가 각자 인스턴스를 하나씩 갖는다 |
| `mime.ts` | 파일 확장자 → MIME 타입 매핑 `mimeForPath()`. `local_folder_read_file`이 raw 바이트만 돌려주므로 mime 판정이 shim 책임이다 |
| `audio-device.ts` | `window.audioDevice` 구현 — 4개 커맨드를 그대로 호출. `getConfig`/`setConfig`는 렌더러 미사용이지만 `d.ts` 계약 유지를 위해 남겨 둔 표면이다 |
| `audio-capture.ts` | `window.audioCapture` 구현 — `createStreamChannelPair()`로 data 스트림 중계 |
| `audio-playcapture.ts` | `window.audioPlayCapture` 구현 — 재생 PCM 업로드 핸드셰이크(4 MB 청크) + 스트리밍 재생용 `writePcm` + data 스트림 중계 |
| `local-folder.ts` | `window.localFolder` 구현 — `select`는 절대 reject하지 않고(예상 밖 reject는 취소와 동등 처리), `readFile`은 raw 응답이라 `invoke`를 직접 쓴다 |
| `file-export.ts` | Tauri 전용 저장 다이얼로그 우회 커맨드 `saveFileViaTauri()` |
| `wasm-asset.ts` | `window.wasmAsset` 구현 — 암호화 배포된 WASM 바이너리 로딩 |

## 4. 의존성 및 흐름

- **가져오는 것**: `@tauri-apps/api/core`(`invoke`, `Channel`), `@tauri-apps/api/event`(`listen`), `@/shared/types/native-bridge`.
- **`src-tauri/`와의 접점**: 이 도메인 전체가 Rust `#[tauri::command]` 커맨드와 1:1로 맞물리는 계약을 구현합니다. 그 계약의 기준은 `contract.ts` 하나뿐입니다. 커맨드 이름은 snake_case, 인자 키는 camelCase로 통일합니다 — Tauri v2가 그 사이를 자동 변환하기 때문입니다. 예외는 `deviceUID` 하나로, Rust 구조체가 `#[serde(rename = "deviceUID")]`로 대문자 그대로 받습니다.
- **소비하는 쪽**: `installTauriBridge()`는 `src/app/TauriBridgeInit.tsx`가 모듈 스코프에서 호출합니다. 그다음부터 `features/audio`의 `useNativeCapture.ts`/`useNativeAudioDevice.ts`/`local-folder.ts` 등은 `window.audioDevice` 같은 전역으로만 이 도메인을 씁니다(직접 import 없음). 직접 import하는 곳은 두 군데뿐입니다. `shared/lib/download.ts`의 `downloadBlob()`이 `file-export.ts`의 `saveFileViaTauri()`를 호출하고 `engine/adapters/wasm-client.ts`가 `window.wasmAsset`을 참조합니다.

```
src/app/TauriBridgeInit.tsx(모듈 스코프, React 마운트 전) → installTauriBridge()
  __TAURI_INTERNALS__ 존재 확인
  → window.audioDevice / audioCapture / audioPlayCapture / localFolder / wasmAsset 설치

호출부(예: useNativeCapture.ts) → window.audioCapture.start(opts)
  → createAudioCaptureBridge().start() → createStreamChannelPair().createChannels()
  → safeInvoke("audio_capture_start", { opts, data: Channel })
  → Rust audio_capture.rs가 Channel로 청크 스트리밍 → ChannelHub.dispatch() → onData 구독자에게 전달
```

## 5. 주요 인터페이스 / 진입점

- **`installTauriBridge(): void`** — 이 도메인의 유일한 외부 진입점. 이미 설치됐거나 `window`가 없거나(정적 export의 서버 렌더 경로) Tauri 런타임이 아니면 아무것도 하지 않습니다.
- **`COMMANDS` / `ARG_KEYS` / `HEADERS` / `EVENTS`**(`contract.ts`) — Rust 계약을 담은 상수. 새 커맨드/이벤트를 추가할 때 반드시 여기부터 등록합니다.
- **`safeInvoke<T extends {success, error?}>(cmd, args?, options?): Promise<T>`** — `{success, error}` 반환 규약을 쓰는 커맨드 전용입니다. `local_folder_select`(취소=성공이라 규약이 다름)·`local_folder_read_file`·`wasm_asset_load`·`file_export_*`(raw 응답 또는 `canceled` 규약)에는 쓰지 않습니다.
- **`syncListen<T>(event, handler): () => void`** — 동기 unsubscribe 함수를 돌려줍니다. `useEffect` cleanup에 그대로 리턴하면 됩니다. unsubscribe가 `listen()` resolve보다 먼저 호출돼도 이후 이벤트가 핸들러를 타지 않습니다.
- **`class ChannelHub<T>`** — `reset()`(새 세션 시작 시 백로그 정리) / `dispatch(payload)` / `subscribe(cb): () => void`. 백로그는 **최초 구독자 한 명에게만** 플러시합니다.
- **`createStreamChannelPair(): { createChannels, onData }`** — `createChannels()`는 허브를 리셋하고 새 `Channel`을 만들어 돌려주므로 `start()` 안에서 호출합니다. `onData`는 그대로 브리지의 `onData` 표면이 됩니다.
- **`saveFileViaTauri(blob: Blob, filename: string): Promise<void>`** — 임시 파일을 쓰고 저장 다이얼로그를 여는 2단계 invoke. 사용자가 다이얼로그를 취소하면 조용히 반환합니다.
- **`mimeForPath(filePath: string): string`** — 확장자로 오디오 MIME을 판정합니다. 모르는 확장자는 `application/octet-stream`입니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — `src/shared/` 도메인에서 분리해 신설했습니다. WASM 암호화 배포용 `wasm-asset.ts`(`window.wasmAsset`)가 이미 들어와 있는 상태까지 반영했습니다(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함).
- 2026-08-11: 공용 배선 추출과 스트림 표면 정리를 반영했습니다. `stream-channel-pair.ts`를 새로 만들어 `audio-capture.ts`/`audio-playcapture.ts`가 각자 갖고 있던 허브+Channel 배선을 팩토리 하나로 합쳤습니다. 그 과정에서 두 브리지의 `mark` 스트림은 사라져 `data` 하나만 남았습니다. `types.ts`는 삭제됐습니다 — `native-bridge.d.ts`의 타입을 미러링하던 파일인데, 각 브리지가 그 타입을 직접 import하면서 필요가 없어졌습니다. `contract.ts`에는 보호 스트리밍 재생용 `audio_playcapture_write_pcm`과 `opts.stream`/`opts.prefillMs` 인자 키가 들어왔고 `audio-playcapture.ts`는 그에 맞춰 `writePcm()`을 노출합니다. §4의 `downloadBlob()` 위치를 `shared/lib/utils.ts`에서 현재 위치인 `shared/lib/download.ts`로 정정했습니다. 섹션 2·3·4·5 부분 갱신 (커밋 범위: 4d86f32..HEAD, 작업 트리 포함)
