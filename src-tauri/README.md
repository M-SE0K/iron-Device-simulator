# src-tauri

## 1. 도메인 설명

앱의 유일한 데스크톱 셸(Tauri v2, Rust)입니다. 렌더러가 요청하는 오디오 장치 제어·V/I 캡처·로컬 폴더 접근·파일 저장·WASM 엔진 로딩을 실제 OS 리소스(네이티브 헬퍼 프로세스, 파일시스템, 저장 다이얼로그)에 연결합니다.

## 2. 프로젝트 전반에서의 역할

과거 Electron의 `electron/main.js` + `electron/ipc/*.js`가 하던 일을 그대로 대체합니다. `main.rs`는 합성 루트로서 플러그인·상태 등록과 앱 라이프사이클(종료 시 자식 프로세스 정리)만 담당합니다. 커맨드 18개는 `audio_device`/`audio_capture`/`audio_playcapture`/`local_folder`/`file_export`/`wasm_asset` 각 모듈에 나뉘어 있습니다. `helper.rs`와 `streaming.rs`는 이 모듈들이 공유하는 하부 로직(헬퍼 바이너리 경로 해석, 상주 프로세스 관리)을 모아둔 leaf 모듈입니다. 이 도메인 자체는 `src/shared/lib/tauri-bridge/`가 정의한 계약(`contract.ts`)의 Rust 쪽 짝입니다 — 커맨드 이름과 인자 키가 그쪽과 1:1로 맞물립니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `src/main.rs` | 앱 합성 루트 — 플러그인/상태 등록, `invoke_handler` 목록, 종료 시 정리(`cleanup`) |
| `src/audio_device.rs` | `audio_device_list/query` — 헬퍼를 1회성으로 실행해 결과를 그대로 전달 (렌더러가 쓰지 않던 `get_config`/`set_config`는 제거) |
| `src/audio_capture.rs` | `audio_capture_start/stop` — 상주 `capture` 헬퍼로 V/I 캡처 |
| `src/audio_playcapture.rs` | `audio_playcapture_start_write/write_chunk/finalize_write/cancel_write/start/write_pcm/control/stop` — 재생 PCM 업로드 핸드셰이크 + 상주 `play-capture` 헬퍼. `start`의 `stream:true`가 Protected 스트림 모드(`--stream`), `write_pcm`이 그 모드의 실시간 PCM 공급 |
| `src/local_folder.rs` | `local_folder_select/unwatch/read_file` — 폴더 선택, `notify` 기반 변경 감시, 허용 폴더 하위로 읽기 제한 |
| `src/streaming.rs` | `StreamController` + `run_streaming_helper` — capture/play-capture가 공유하는 상주 헬퍼 실행·종료·stdout 중계 공통 로직. 자식 stdin 핸들을 분리 보관해 `write_stdin_bytes()`(실시간 PCM 프레임 공급)를 지원 |
| `src/file_export.rs` | `file_export_write_temp/save` — Records export가 저장 다이얼로그를 띄우기 위한 2단계 커맨드 |
| `src/helper.rs` | `helper_path`/`is_supported_platform`/`with_device`/`run_audio_helper` — 헬퍼 바이너리 경로 해석과 플랫폼 판정, 다른 오디오 모듈이 재사용 |
| `src/wasm_asset.rs` | `wasm_asset_load` — 암호화된 `ff_prot.wasm.enc`를 AES-256-GCM으로 복호화해 raw bytes로 반환. 평문 리소스 폴백은 `plain-wasm` 피처가 켜진 `--dev` 빌드에서만 컴파일됨 |
| `src/wasm_key.rs` | 빌드 시점 생성 산출물(git 제외) — `stage-encrypted-wasm.sh`가 채우는 키 시드 상수(`WASM_SEED_A`/`WASM_SEED_B`/`WASM_SALT`) |
| `tauri.conf.json` | 공통 설정 — `frontendDist: "../out"`, 창 크기, `bundle.resources`(암호화 WASM) |
| `tauri.macos.conf.json` / `tauri.windows.conf.json` | 플랫폼별 병합 설정 — `bundle.externalBin`(헬퍼 사이드카), 번들 타깃(dmg/nsis), 서명/언어 설정 |
| `capabilities/default.json` | 메인 창에 허용하는 권한 목록(`core:default`, `core:event:default`, `dialog:default`) |
| `Cargo.toml` / `build.rs` | Rust 의존성(tauri, tauri-plugin-dialog, serde, notify, aes-gcm 등) + `[features] devtools`/`plain-wasm` + `tauri_build::build()` |
| `binaries/` | 패키징 스크립트가 채우는 `externalBin` 사이드카(`audio-device-helper-<타깃 트리플>[.exe]`) — git 제외 |
| `resources/ff_prot.wasm.enc` | 암호화된 WASM 엔진 바이너리 — 패키징 스크립트가 채움, git 제외 |

## 4. 의존성 및 흐름

- **가져오는 것**: `tauri`/`tauri-plugin-dialog`(창·다이얼로그·IPC), `serde`/`serde_json`(직렬화), `notify`/`notify-debouncer-mini`(폴더 감시), `aes-gcm`(WASM 복호화, 순수 Rust — Windows를 `cargo-xwin`으로 크로스 컴파일하므로 OpenSSL 링킹이 필요한 크레이트는 배제). 오디오 처리 자체는 하지 않고 `native/{macos,windows}/audio-device-helper` 외부 바이너리를 자식 프로세스로 실행해 위임합니다.
- **소비하는 쪽**: `src/shared/lib/tauri-bridge/`가 이 도메인의 18개 커맨드를 `invoke()`로 호출합니다. 커맨드 이름·인자 키는 `tauri-bridge/contract.ts`가 단일 소스로 관리하며 이 도메인은 그 계약을 그대로 구현합니다.
- **패키징 스크립트와의 접점**: `scripts/build/build-tauri.sh`가 `build-desktop.sh`(정적 코어 빌드) → `stage-encrypted-wasm.sh`(WASM 암호화 + `wasm_key.rs` 생성) → 플랫폼별 헬퍼 빌드 → `binaries/`에 사이드카 배치 → `npx tauri build` 순서로 이 도메인을 완성된 앱으로 묶습니다. `tauri build`는 호스트 OS와 같은 타깃만 만들 수 있습니다(Windows만 `cargo-xwin`으로 예외적 크로스 경로 지원). `--target`에 맞는 `tauri.{macos,windows}.conf.json`은 자동으로 병합됩니다.

```
tauri-bridge(TS, invoke) → src-tauri 커맨드
  audio_device_*      → helper.rs::run_audio_helper() → 헬퍼 1회 실행 → stdout JSON 그대로 반환
  audio_capture_*      ┐
  audio_playcapture_* ┘→ streaming.rs::run_streaming_helper() → 상주 헬퍼 spawn
                          → stdout 첫 줄 JSON 헤더 파싱 → 이후 raw PCM을 Channel로 중계
  audio_playcapture_write_pcm(raw body) → "pcm <n>\n" 프레이밍 → 상주 헬퍼 stdin
                          (Protected 스트림 모드 — start의 stream:true가 --stream으로 연 헬퍼)
  local_folder_*       → notify 감시 + 허용 폴더 하위 read_file
  file_export_*        → write_temp(sync, raw body) → save(async, 다이얼로그) → rename/copy
  wasm_asset_load       → resources/ff_prot.wasm.enc 읽기 → wasm_key.rs 시드로 키 파생·복호화 → raw bytes
                          (--dev 빌드만 plain-wasm 피처로 평문 리소스 폴백을 먼저 시도)

build-tauri.sh: build-desktop.sh → stage-encrypted-wasm.sh(wasm_key.rs 생성 + wasm.enc 암호화)
  → 헬퍼 빌드(mac: build-mac.sh / windows: build-win.sh) → binaries/ 사이드카 배치 → tauri build
```

## 5. 주요 인터페이스 / 진입점

이 도메인의 외부 진입점은 `#[tauri::command]`로 등록된 18개 커맨드뿐입니다(모두 `main.rs`의 `invoke_handler!`에 등록). 시그니처를 소비하는 쪽은 렌더러가 아니라 `tauri-bridge/`이므로 여기서는 각 커맨드의 계약만 정리합니다.

- **`audio_device_list() -> Value`** / **`audio_device_query(opts) -> Value`** — 헬퍼 CLI를 1회성으로 실행하고 stdout JSON을 그대로 반환합니다. 실패해도 `Err`를 던지지 않고 항상 `{success, ...}` 형태로 수렴합니다. 렌더러가 쓰지 않던 `audio_device_get_config`/`audio_device_set_config`는 제거됐습니다.
- **`audio_capture_start(opts, data: Channel, mark: Channel) -> Value`** / **`audio_capture_stop() -> Value`** — 상주 `capture` 헬퍼를 열어 int16 인터리브 PCM을 `data` 채널로 스트리밍합니다. 이미 실행 중이면 `capture-already-running`.
- **`audio_playcapture_start_write() -> Value`** → **`audio_playcapture_write_chunk(request) -> Value`**(반복) → **`audio_playcapture_finalize_write(write_id) -> Value`** — 재생용 PCM을 청크 단위로 임시 파일에 쓰는 3단계 핸드셰이크. **`audio_playcapture_cancel_write(write_id) -> Value`**로 언제든 취소할 수 있습니다. Original(`--ref`) 재생 모드에서만 필요합니다.
- **`audio_playcapture_start(opts, data: Channel, mark: Channel) -> Value`** — 상주 `play-capture` 헬퍼를 시작합니다. 모드가 둘입니다: `opts.stream`이 없거나 false면 `finalize_write`로 완성된 ref 파일을 소비하는 `--ref` 모드(refWriteId가 없거나 finalize를 거치지 않았으면 `missing-ref-write-id`), `stream:true`면 ref 파일 없이 `--stream`으로 여는 Protected 스트림 모드(`opts.prefillMs`는 `--prefill-ms`로 전달).
- **`audio_playcapture_write_pcm(request) -> Value`** — Protected 스트림 모드의 실시간 PCM 공급. raw invoke body를 받아 `"pcm <바이트수>\n"` 헤더를 붙여 헬퍼 stdin에 씁니다. 빈 body는 no-op(`success:true`), 헬퍼가 없으면 `not-running`. raw body(`Request<'_>`)를 받는 제약 때문에 sync 커맨드입니다.
- **`audio_playcapture_control(action: "pause"|"resume"|"end") -> Value`** / **`audio_playcapture_stop() -> Value`** — pause/resume/end는 헬퍼 stdin으로 한 줄씩 중계합니다(`end`는 스트림 모드의 "더 보낼 PCM 없음" 신호). stop은 stdin EOF → 200ms 유예 → kill.
- **`local_folder_select() -> Result<Value, String>`** — 폴더 선택 다이얼로그(async) + 오디오 파일 스캔 + 변경 감시 시작. **`local_folder_unwatch() -> Value`**로 감시만 중단. **`local_folder_read_file(path) -> Result<Response, String>`** — 마지막으로 select된 폴더 하위 경로만 허용, raw bytes 반환.
- **`file_export_write_temp(request) -> Result<Value, String>`**(sync, raw body) → **`file_export_save(temp_path, filename) -> Result<Value, String>`**(반드시 async — 저장 다이얼로그를 여는 커맨드가 sync면 macOS WKWebView 메인 스레드에서 데드락) — 큰 export 파일을 저장 다이얼로그로 옮기는 2단계 커맨드.
- **`wasm_asset_load() -> Result<Response, String>`** — `resources/ff_prot.wasm.enc`를 읽어 복호화한 평문 WASM bytes를 반환합니다. 복호화 키는 `wasm_key.rs`의 시드(`WASM_SEED_A` XOR `WASM_SEED_B` → HKDF-SHA256 + `WASM_SALT`)로 파생한 AES-256-GCM 키입니다. 평문 리소스(`ff_prot.wasm`)를 먼저 찾는 폴백은 `plain-wasm` 피처가 켜진 `--dev` 빌드에서만 컴파일됩니다. 배포/`--devtools` 빌드에는 그 코드 자체가 없습니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — Electron 제거 이후 Tauri가 유일한 데스크톱 셸이 된 현재 상태 기준(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
- 2026-08-19: Protected 스트림 모드 반영 — `audio_playcapture_start`에 `stream`/`prefillMs` 옵션(`--stream`/`--prefill-ms`), `audio_playcapture_write_pcm` 커맨드·`control`의 `"end"` 액션 추가, `StreamController`가 stdin 핸들을 분리 보관. 평문 WASM 폴백을 `plain-wasm` 피처로 `--dev` 빌드 전용 격리, 미사용 `audio_device_get_config`/`set_config` 제거(커맨드 19→18개) (커밋 범위: 67e3aa4..24d1daa)
