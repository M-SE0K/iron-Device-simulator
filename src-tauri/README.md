# src-tauri

## 1. 도메인 설명

앱의 유일한 데스크톱 셸(Tauri v2, Rust)입니다. 렌더러가 요청하는 오디오 장치 제어·V/I 캡처·로컬 폴더 접근·파일 저장·WASM 엔진 로딩을 실제 OS 리소스(네이티브 헬퍼 프로세스, 파일시스템, 저장 다이얼로그)에 연결합니다.

## 2. 프로젝트 전반에서의 역할

과거 Electron의 `electron/main.js` + `electron/ipc/*.js`가 하던 일을 그대로 대체합니다. `main.rs`는 합성 루트로서 플러그인·상태 등록, 앱 라이프사이클(종료 시 자식 프로세스 정리), 배포 빌드의 DevTools 차단을 담당합니다. 커맨드 20개는 `audio_device`/`audio_capture`/`audio_playcapture`/`local_folder`/`file_export`/`wasm_asset` 각 모듈로 나뉩니다. `helper.rs`와 `streaming.rs`는 이 모듈들이 공유하는 하부 로직(헬퍼 바이너리 경로 해석, 상주 프로세스 관리)을 모아둔 leaf 모듈입니다. 이 도메인 자체는 `src/shared/lib/tauri-bridge/`가 정의한 계약(`contract.ts`)의 Rust 쪽 짝입니다 — 커맨드 이름과 인자 키가 그쪽과 1:1로 맞물립니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `src/main.rs` | 앱 합성 루트 — 플러그인/상태 등록, `invoke_handler` 목록, 종료 시 정리(`cleanup`), DevTools 차단(`configure_devtools_access` + `on_page_load`로 주입하는 `DEVTOOLS_GUARD_JS`) |
| `src/audio_device.rs` | `audio_device_list/get_config/set_config/query` — 헬퍼를 1회성으로 실행해 결과를 그대로 전달 |
| `src/audio_capture.rs` | `audio_capture_start/stop` — 상주 `capture` 헬퍼로 V/I 캡처 |
| `src/audio_playcapture.rs` | `audio_playcapture_start_write/write_chunk/finalize_write/cancel_write/start/write_pcm/control/stop` — 재생 PCM 청크 업로드 핸드셰이크 + 상주 `play-capture` 헬퍼(`--ref` 파일 모드와 `--stream` 스트리밍 모드 양쪽) |
| `src/local_folder.rs` | `local_folder_select/unwatch/read_file` — 폴더 선택, `notify` 기반 변경 감시, 허용 폴더 하위로 읽기 제한 |
| `src/streaming.rs` | `StreamController` + `run_streaming_helper` — capture/play-capture가 공유하는 상주 헬퍼 실행·종료·stdout 중계 공통 로직. 자식의 stdin은 `Child`에서 떼어내 별도 뮤텍스로 보관한다 |
| `src/file_export.rs` | `file_export_write_temp/save` — Records export가 저장 다이얼로그를 띄우기 위한 2단계 커맨드 |
| `src/helper.rs` | `helper_path`/`is_supported_platform`/`with_device`/`run_audio_helper` — 헬퍼 바이너리 경로 해석과 플랫폼 판정, 다른 오디오 모듈이 재사용 |
| `src/wasm_asset.rs` | `wasm_asset_load` — 암호화된 `ff_prot.wasm.enc`를 AES-256-GCM으로 복호화해 raw bytes로 반환. 키는 상수로 두지 않고 seed 두 개를 XOR한 값에서 HKDF-SHA256으로 런타임 파생한다 |
| `src/wasm_key.rs` | 빌드 시점 생성 산출물(git 제외) — `stage-encrypted-wasm.sh`가 채우는 `WASM_SEED_A`/`WASM_SEED_B`/`WASM_SALT` |
| `tauri.conf.json` | 공통 설정 — `frontendDist: "../out"`, 창 크기, `bundle.resources`(암호화 WASM) |
| `tauri.macos.conf.json` / `tauri.windows.conf.json` | 플랫폼별 병합 설정 — `bundle.externalBin`(헬퍼 사이드카), 번들 타깃(dmg/nsis), 서명/언어 설정 |
| `capabilities/default.json` | 메인 창에 허용하는 권한 목록(`core:default`, `core:event:default`, `dialog:default`) |
| `Cargo.toml` / `build.rs` | Rust 의존성(tauri, tauri-plugin-dialog, serde, notify, aes-gcm, hkdf, sha2) + `tauri_build::build()`. `[features] devtools`는 기본 꺼짐이라 배포 빌드에는 인스펙터가 아예 컴파일되지 않는다 |
| `binaries/` | 패키징 스크립트가 채우는 `externalBin` 사이드카(`audio-device-helper-<타깃 트리플>[.exe]`) — git 제외 |
| `resources/ff_prot.wasm.enc` | 암호화된 WASM 엔진 바이너리 — 패키징 스크립트가 채움, git 제외 |

## 4. 의존성 및 흐름

- **가져오는 것**: `tauri`/`tauri-plugin-dialog`(창·다이얼로그·IPC), `serde`/`serde_json`(직렬화), `notify`/`notify-debouncer-mini`(폴더 감시), `aes-gcm`/`hkdf`/`sha2`(WASM 복호화와 키 파생). 세 암호 크레이트는 모두 순수 Rust(RustCrypto)입니다 — Windows를 `cargo-xwin`으로 크로스 컴파일하므로 OpenSSL 링킹이 필요한 크레이트는 배제했습니다. 오디오 처리 자체는 하지 않고 `native/{macos,windows}/audio-device-helper` 외부 바이너리를 자식 프로세스로 실행해 위임합니다.
- **소비하는 쪽**: `src/shared/lib/tauri-bridge/`가 이 도메인의 커맨드를 `invoke()`로 호출합니다. 커맨드 이름·인자 키는 `tauri-bridge/contract.ts`가 단일 소스로 관리하며 이 도메인은 그 계약을 그대로 구현합니다.
- **패키징 스크립트 접점**: `scripts/build/build-tauri.sh`가 `build-desktop.sh`(정적 코어 빌드) → `stage-encrypted-wasm.sh`(WASM 암호화 + `wasm_key.rs` 생성) → 플랫폼별 헬퍼 빌드 → `binaries/`에 사이드카 배치 → `npx tauri build` 순서로 이 도메인을 완성된 앱으로 묶습니다. `tauri build`는 호스트 OS와 같은 타깃만 만들 수 있습니다(Windows만 `cargo-xwin`으로 예외적 크로스 경로 지원). `--target`에 맞는 `tauri.{macos,windows}.conf.json`은 자동으로 병합됩니다.

```
tauri-bridge(TS, invoke) → src-tauri 커맨드
  audio_device_*      → helper.rs::run_audio_helper() → 헬퍼 1회 실행 → stdout JSON 그대로 반환
  audio_capture_*      ┐
  audio_playcapture_* ┘→ streaming.rs::run_streaming_helper() → 상주 헬퍼 spawn
                          → stdout 첫 줄 JSON 헤더 파싱 → 이후 raw PCM을 Channel로 중계
                          → (--stream 모드) write_pcm이 헬퍼 stdin으로 재생 PCM을 역방향 전송
  local_folder_*       → notify 감시 + 허용 폴더 하위 read_file
  file_export_*        → write_temp(sync, raw body) → save(async, 다이얼로그) → rename/copy
  wasm_asset_load       → resources/ff_prot.wasm.enc 읽기 → seed XOR + HKDF-SHA256으로 키 파생 → 복호화 → raw bytes

build-tauri.sh: build-desktop.sh → stage-encrypted-wasm.sh(wasm_key.rs 생성 + wasm.enc 암호화)
  → 헬퍼 빌드(mac: build-mac.sh / windows: build-win.sh) → binaries/ 사이드카 배치 → tauri build
```

## 5. 주요 인터페이스 / 진입점

이 도메인의 외부 진입점은 `#[tauri::command]`로 등록된 커맨드 20개뿐입니다(모두 `main.rs`의 `invoke_handler!`에 등록). 시그니처를 소비하는 쪽은 렌더러가 아니라 `tauri-bridge/`이므로 여기서는 각 커맨드의 계약만 정리합니다.

- **`audio_device_list() -> Value`** / **`audio_device_get_config(opts) -> Value`** / **`audio_device_set_config(opts) -> Value`** / **`audio_device_query(opts) -> Value`** — 헬퍼 CLI를 1회성으로 실행하고 stdout JSON을 그대로 반환합니다. 실패해도 `Err`를 던지지 않고 항상 `{success, ...}` 형태로 수렴합니다.
- **`audio_capture_start(opts, data: Channel) -> Result<Value, String>`** / **`audio_capture_stop() -> Value`** — 상주 `capture` 헬퍼를 열어 int16 인터리브 PCM을 `data` 채널로 스트리밍합니다. 이미 실행 중이면 `capture-already-running`, 지원하지 않는 플랫폼이면 `unsupported-platform`.
- **`audio_playcapture_start_write() -> Value`** → **`audio_playcapture_write_chunk(request) -> Value`**(반복) → **`audio_playcapture_finalize_write(write_id) -> Value`** — 재생용 PCM을 청크 단위로 임시 파일에 쓰는 3단계 핸드셰이크. **`audio_playcapture_cancel_write(write_id) -> Value`**로 언제든 취소할 수 있습니다. 파일 모드(`--ref`)에서만 필요한 경로입니다.
- **`audio_playcapture_start(opts, data: Channel) -> Result<Value, String>`** — 상주 `play-capture` 헬퍼를 시작합니다. `opts.stream`이 참이면 `--ref` 대신 `--stream`으로 띄워 재생 PCM을 stdin으로 받고(`opts.prefillMs`로 재생 시작 전 링에 채울 분량을 조절, 생략 시 헬퍼 기본값 40 ms), 거짓이면 `finalize_write`로 완성된 ref 파일을 소비합니다. 파일 모드인데 `refWriteId`가 없거나 finalize를 거치지 않았으면 `missing-ref-write-id`.
- **`audio_playcapture_write_pcm(request) -> Value`**(raw body) — `--stream` 모드 전용. 보호 처리된 PCM 한 덩이를 `"pcm <바이트수>\n"` + 페이로드로 프레이밍해 헬퍼 stdin에 한 번의 `write_all`로 밀어 넣습니다. 한 번에 쓰기 때문에 헤더와 페이로드 사이에 `pause`/`end` 같은 제어 라인이 끼어들 수 없습니다.
- **`audio_playcapture_control(action) -> Value`** / **`audio_playcapture_stop() -> Value`** — `control`은 `"pause"`/`"resume"`/`"end"` 한 줄을 헬퍼 stdin으로 중계합니다. `stop`은 세대 번호를 올린 **뒤에** stdin 핸들을 떨어뜨려(EOF) 정상 종료 경로를 태우고, 200 ms 안에 끝나지 않으면 `kill()`로 정리합니다. 순서가 반대면 EOF를 받은 헬퍼가 먼저 죽어 리더 스레드가 사용자 stop을 비정상 종료로 오인해 `ended`를 내보냅니다.
- **`local_folder_select() -> Result<Value, String>`** — 폴더 선택 다이얼로그(async) + 오디오 파일 스캔 + 변경 감시 시작. **`local_folder_unwatch() -> Value`**로 감시만 중단. **`local_folder_read_file(path) -> Result<Response, String>`** — 마지막으로 select된 폴더 하위 경로만 허용, raw bytes 반환.
- **`file_export_write_temp(request) -> Result<Value, String>`**(sync, raw body) → **`file_export_save(temp_path, filename) -> Result<Value, String>`**(반드시 async — 저장 다이얼로그를 여는 커맨드가 sync면 macOS WKWebView 메인 스레드에서 데드락) — 큰 export 파일을 저장 다이얼로그로 옮기는 2단계 커맨드.
- **`wasm_asset_load() -> Result<Response, String>`** — `resources/ff_prot.wasm.enc`를 읽어 AES-256-GCM으로 복호화한 평문 WASM bytes를 반환합니다. 키는 `WASM_SEED_A ^ WASM_SEED_B`를 root로, `WASM_SALT`를 salt로 삼아 HKDF-SHA256으로 파생하므로 바이너리 안에 "키처럼 보이는" 32바이트 연속 상수가 남지 않습니다. 파생 상수는 빌드 쪽 `derive-wasm-key.js`와 문자열 단위로 같아야 하며, 하나라도 다르면 복호화가 실패합니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — Electron 제거 이후 Tauri가 유일한 데스크톱 셸이 된 현재 상태 기준(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
- 2026-08-11: 보호 스트리밍 재생과 WASM 키 파생 변경을 반영했습니다. `audio_playcapture_write_pcm`을 추가해 `--stream` 모드에서는 보호 처리된 PCM을 헬퍼 stdin으로 역방향 전송합니다. 그 경로가 `is_running()`/reap 폴링과 child 뮤텍스를 다투지 않도록 `streaming.rs`의 `StreamController`는 자식 stdin을 별도 뮤텍스로 떼어내 보관합니다. 그에 맞춰 EOF를 보내는 주체도 `stop_streaming_child`에서 `stop()`으로 옮겼습니다 — 세대를 올린 뒤에 stdin을 떨어뜨려야 사용자 stop이 `ended` 이벤트로 새어 나가지 않기 때문입니다. `wasm_key.rs`가 내주는 값은 `WASM_KEY` 상수 하나에서 `WASM_SEED_A`/`WASM_SEED_B`/`WASM_SALT` 세 개로 바뀌었습니다. `wasm_asset.rs`는 이 세 값을 HKDF-SHA256으로 조합해 런타임에 키를 만듭니다(`hkdf`/`sha2` 의존성 추가). 커맨드 개수는 실제 `invoke_handler` 등록 수인 20개로 정정했습니다. 실재하지 않는 `mark: Channel` 파라미터 서술은 §5에서 걷어냈고 `main.rs`의 DevTools 차단 책임은 §2·§3에 명시했습니다. 섹션 2·3·4·5 부분 갱신 (커밋 범위: 67e3aa4..HEAD, 작업 트리 포함)
