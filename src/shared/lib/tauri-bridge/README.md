# tauri-bridge

## 1. 도메인 설명

Tauri의 IPC(`invoke`/`Channel`/이벤트)를 Electron 시절과 똑같은 `window.audioDevice`/`audioCapture`/`audioPlayCapture`/`localFolder`/`wasmAsset` 전역 모양으로 감싸는 shim 계층입니다. 나머지 앱 코드는 데스크톱 셸이 Tauri라는 사실도, IPC 동작 방식도 몰라도 됩니다.

## 2. 프로젝트 전반에서의 역할

`installTauriBridge()`는 Tauri 런타임, 곧 `window.__TAURI_INTERNALS__`가 있을 때만 이 전역 5개를 채웁니다. 각 브리지 파일은 대응하는 Rust 커맨드를 그대로 호출만 하고, 계약(커맨드 이름·인자 키·이벤트 이름)은 `contract.ts` 한 곳에 모아 `src-tauri/`의 Rust 코드와 나란히 유지합니다. 여러 브리지가 똑같이 겪는 문제는 `safe-invoke.ts`/`sync-listen.ts`/`channel-registry.ts`가 공용으로 풉니다. 에러 반환 규약, 동기 unsubscribe, 세션 경계를 넘는 리스너 유지 세 가지입니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `index.ts` | `installTauriBridge()` — 5개 전역을 한 번만 설치하는 진입점 |
| `contract.ts` | `COMMANDS`/`ARG_KEYS`/`HEADERS`/`EVENTS` — Rust 커맨드 이름·인자 키·이벤트 이름의 단일 소스 |
| `types.ts` | `native-bridge.d.ts`에 있지만 export되지 않은 결과 타입을 shim 내부용으로 미러링(구조적 타입 검증 역할) |
| `safe-invoke.ts` | `invoke()` 실패(reject)를 `{success:false, error}` 반환값으로 정규화하는 `safeInvoke()` |
| `sync-listen.ts` | Tauri `listen()`의 비동기 결과를 동기 unsubscribe 함수로 감싸는 `syncListen()` |
| `channel-registry.ts` | `ChannelHub` — 세션(start~stop) 경계를 넘어 살아있는 콜백 레지스트리, 구독자 없을 때 백로그 버퍼링(최대 512개) |
| `mime.ts` | 파일 확장자 → MIME 타입 매핑 `mimeForPath()` |
| `audio-device.ts` | `window.audioDevice` 구현 |
| `audio-capture.ts` | `window.audioCapture` 구현 — `ChannelHub`로 data/mark 스트림 중계 |
| `audio-playcapture.ts` | `window.audioPlayCapture` 구현 — 재생 PCM 업로드 핸드셰이크 + data/mark 스트림 중계 |
| `local-folder.ts` | `window.localFolder` 구현 |
| `file-export.ts` | Tauri 전용 저장 다이얼로그 우회 커맨드 `saveFileViaTauri()` |
| `wasm-asset.ts` | `window.wasmAsset` 구현 — 암호화 배포된 WASM 바이너리 로딩 |

## 4. 의존성 및 흐름

- **가져오는 것**: `@tauri-apps/api/core`(`invoke`, `Channel`), `@tauri-apps/api/event`(`listen`), `@/shared/types/native-bridge`.
- **`src-tauri/`와의 접점**: 이 도메인은 전체가 Rust `#[tauri::command]` 커맨드와 1:1로 맞물리는 계약을 구현합니다. 그 계약의 기준은 `contract.ts` 하나뿐입니다.
- **소비하는 쪽**: `installTauriBridge()`는 `src/app/TauriBridgeInit.tsx`가 모듈 스코프에서 호출합니다. 그다음부터 `features/audio`의 `useNativeCapture.ts`/`useNativeAudioDevice.ts`/`local-folder.ts` 등은 `window.audioDevice` 같은 전역으로만 이 도메인을 간접적으로 씁니다(직접 import 없음). 다만 `shared/lib/utils.ts`의 `downloadBlob()`은 `file-export.ts`의 `saveFileViaTauri()`를 직접 호출하고, `engine/adapters/wasm-client.ts`는 `window.wasmAsset`을 직접 참조합니다.

```
src/app/TauriBridgeInit.tsx(모듈 스코프, React 마운트 전) → installTauriBridge()
  __TAURI_INTERNALS__ 존재 확인
  → window.audioDevice / audioCapture / audioPlayCapture / localFolder / wasmAsset 설치

호출부(예: useNativeCapture.ts) → window.audioCapture.start(opts)
  → createAudioCaptureBridge().start() → safeInvoke("audio_capture_start", { opts, data: Channel, mark: Channel })
  → Rust audio_capture.rs가 Channel로 청크 스트리밍 → dataHub.dispatch() → onData 구독자에게 전달
```

## 5. 주요 인터페이스 / 진입점

- **`installTauriBridge(): void`** — 이 도메인의 유일한 외부 진입점. 이미 설치됐거나 Tauri 런타임이 아니면 아무것도 하지 않습니다.
- **`COMMANDS` / `ARG_KEYS` / `HEADERS` / `EVENTS`**(`contract.ts`) — Rust 계약을 담은 상수. 새 커맨드/이벤트를 추가할 때 반드시 여기부터 등록합니다.
- **`safeInvoke<T extends {success, error?}>(cmd, args?, options?): Promise<T>`** — `{success, error}` 반환 규약을 쓰는 커맨드 전용입니다. `local_folder_select`/`local_folder_read_file`처럼 규약이 다른 커맨드에는 쓰지 않습니다.
- **`syncListen<T>(event, handler): () => void`** — 동기 unsubscribe 함수를 돌려줍니다. `useEffect` cleanup에 그대로 리턴하면 됩니다.
- **`class ChannelHub<T>`** — `reset()`(새 세션 시작 시 백로그 정리) / `dispatch(payload)` / `subscribe(cb): () => void`.
- **`saveFileViaTauri(blob: Blob, filename: string): Promise<void>`** — 임시 파일을 쓰고 저장 다이얼로그를 여는 2단계 invoke.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — `src/shared/` 도메인에서 분리해 신설했습니다. WASM 암호화 배포용 `wasm-asset.ts`(`window.wasmAsset`)가 이미 들어와 있는 상태까지 반영했습니다(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함).
