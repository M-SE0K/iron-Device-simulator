// contract.ts — Rust 커맨드 이름 + invoke 인자 키의 단일 소스.
//
// src-tauri와 이 shim은 이 계약을 공유하므로 변경 시 현재 Rust command 시그니처와 함께 검증한다.
//
// Tauri v2는 JS camelCase 인자를 Rust 함수의 snake_case 파라미터로 자동 변환한다
// (`deviceUid` JS → `device_uid: Option<String>` Rust). 그래서 커맨드 이름은 snake_case,
// 인자 키는 camelCase로 통일한다.

/** Rust `#[tauri::command]` 이름 (snake_case). */
export const COMMANDS = {
  audioDeviceList: "audio_device_list",
  audioDeviceGetConfig: "audio_device_get_config",
  audioDeviceSetConfig: "audio_device_set_config",
  audioDeviceQuery: "audio_device_query",

  audioCaptureStart: "audio_capture_start",
  audioCaptureStop: "audio_capture_stop",

  audioPlayCaptureStartWrite: "audio_playcapture_start_write",
  audioPlayCaptureWriteChunk: "audio_playcapture_write_chunk",
  audioPlayCaptureFinalizeWrite: "audio_playcapture_finalize_write",
  audioPlayCaptureCancelWrite: "audio_playcapture_cancel_write",
  audioPlayCaptureStart: "audio_playcapture_start",
  // 스트리밍 재생 모드(opts.stream) 전용 — 보호 처리된 PCM을 프레임 단위로 헬퍼에 밀어 넣는다.
  // write_chunk와 같은 raw invoke body 커맨드지만 write-id 헤더는 없다(스트림이 하나뿐).
  audioPlayCaptureWritePcm: "audio_playcapture_write_pcm",
  audioPlayCaptureControl: "audio_playcapture_control",
  audioPlayCaptureStop: "audio_playcapture_stop",

  localFolderSelect: "local_folder_select",
  localFolderUnwatch: "local_folder_unwatch",
  localFolderReadFile: "local_folder_read_file",

  // Tauri 네이티브 웹뷰(특히 macOS WKWebView)에서 blob + `<a download>` 앵커 다운로드가
  // 저장 다이얼로그를 띄우지 못해 Tauri 전용으로 추가됨(shared/lib/download.ts의 downloadBlob()
  // 참조). 두 커맨드로 나뉘어 있다 — write_temp(sync,
  // raw body)로 바이트를 임시 파일에 쓰고, save(**async fn**)가 저장 다이얼로그를 열어 그
  // 임시 파일을 최종 위치로 옮긴다. save가 async여야 하는 이유는 file_export.rs 참고
  // (sync 커맨드에서 그대로 부르면 메인 스레드 데드락 — 실측 확인됨).
  fileExportWriteTemp: "file_export_write_temp",
  fileExportSave: "file_export_save",

  // WASM 알고리즘 암호화 배포(방법 5) — src-tauri/src/wasm_asset.rs. 인자 없음, raw 응답
  // (tauri::ipc::Response, local_folder_read_file과 동일 패턴).
  wasmAssetLoad: "wasm_asset_load",
} as const;

/**
 * invoke() 두 번째 인자(JSON args 객체)의 키 이름. [조율자 diff 완료 — Rust 시그니처 기준 확정]
 *
 * 구조 규칙 (Rust `#[tauri::command]` 시그니처와 1:1):
 * - start 계열/audio_device 계열은 옵션들을 **`opts` 객체 하나로 중첩**해서 보낸다
 *   (Rust가 `opts: CaptureStartOptions`/`opts: Value` 단일 파라미터로 받는다).
 * - `opts` 내부 키는 native-bridge.d.ts의 원형 그대로 (특히 `deviceUID` — 대문자 UID.
 *   Rust 구조체가 `#[serde(rename = "deviceUID")]`로 받는다).
 * - 스트리밍 Channel 파라미터 이름은 Rust 시그니처의 `data`.
 * - `local_folder_read_file`의 경로 파라미터는 Rust 시그니처의 `path`.
 * - `writeId`(JS) ↔ `write_id`(Rust)는 Tauri v2의 camelCase↔snake_case 자동 매칭에 맡긴다.
 *
 * `totalBytes`는 d.ts `PlayCaptureStartWriteOpts` 계약용 — Rust `start_write`는 이 값을
 * 선언하지 않아 무시된다. Tauri는 커맨드가 선언하지 않은 여분 인자를 조용히 무시하므로
 * 무해하다 [조율자 확인 완료].
 */
export const ARG_KEYS = {
  opts: "opts",
  deviceUID: "deviceUID",
  sampleRate: "sampleRate",
  bufferSize: "bufferSize",
  channels: "channels",
  data: "data",
  refWriteId: "refWriteId",
  refChannels: "refChannels",
  outputChannel: "outputChannel",
  outputChannelR: "outputChannelR",
  stream: "stream",
  prefillMs: "prefillMs",
  writeId: "writeId",
  action: "action",
  path: "path",
  totalBytes: "totalBytes",
  tempPath: "tempPath",
  filename: "filename",
} as const;

/** raw invoke body(writeChunk)에 딸린 write-id는 인자가 아니라 HTTP 유사 헤더로 보낸다. */
export const HEADERS = {
  writeId: "x-write-id",
} as const;

/** Rust `app.emit()` / JS `listen()` 이벤트 이름. */
export const EVENTS = {
  audioCaptureEnded: "audio-capture:ended",
  audioPlayCaptureEnded: "audio-playcapture:ended",
  localFolderChanged: "local-folder:changed",
} as const;

/**
 * 각 호출부는 top-level 키를 `ARG_KEYS`로 구성한다. 커맨드 인자는 Rust 시그니처와 항상
 * 동기화해야 한다.
 *
 * - `audio_playcapture_write_chunk`: JSON 인자 없음 — raw body(Uint8Array) +
 *   `HEADERS.writeId` 헤더로만 전달.
 */
