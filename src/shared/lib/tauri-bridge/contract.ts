// contract.ts — Rust 커맨드 이름 + invoke 인자 키의 단일 소스.
//
// src-tauri(Rust 셸)는 별도 에이전트가 이 shim과 동시에 작성 중이라 서로의 최종 코드를 볼 수
// 없다. 이름이 어긋나면(예: camelCase/snake_case 불일치, 인자 키 오타) 여기 이 파일부터
// 조율자가 Rust `#[tauri::command]` 시그니처와 diff해서 어느 한쪽을 고친다 — 두 곳에 흩어진
// 문자열 리터럴을 각각 찾아 고치지 않아도 되게 하는 것이 이 파일의 유일한 목적이다.
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
  audioPlayCaptureControl: "audio_playcapture_control",
  audioPlayCaptureStop: "audio_playcapture_stop",

  localFolderSelect: "local_folder_select",
  localFolderUnwatch: "local_folder_unwatch",
  localFolderReadFile: "local_folder_read_file",
} as const;

/**
 * invoke() 두 번째 인자(JSON args 객체)의 키 이름. [조율자 diff 완료 — Rust 시그니처 기준 확정]
 *
 * 구조 규칙 (Rust `#[tauri::command]` 시그니처와 1:1):
 * - start 계열/audio_device 계열은 옵션들을 **`opts` 객체 하나로 중첩**해서 보낸다
 *   (Rust가 `opts: CaptureStartOptions`/`opts: Value` 단일 파라미터로 받음 — Electron
 *   preload가 opts 객체 하나를 invoke에 넘기던 원형과도 일치).
 * - `opts` 내부 키는 electron-bridge.d.ts의 원형 그대로 (특히 `deviceUID` — 대문자 UID.
 *   Rust 구조체가 `#[serde(rename = "deviceUID")]`로 받는다).
 * - 스트리밍 Channel 파라미터 이름은 Rust 시그니처의 `data`/`mark`.
 * - `local_folder_read_file`의 경로 파라미터는 Rust 시그니처의 `path`.
 * - `writeId`(JS) ↔ `write_id`(Rust)는 Tauri v2의 camelCase↔snake_case 자동 매칭에 맡긴다.
 *
 * `totalBytes`는 d.ts `PlayCaptureStartWriteOpts` 계약용 — Rust `start_write`는 (Electron
 * 원본과 동일하게) 이 값을 선언하지 않아 무시된다. Tauri는 커맨드가 선언하지 않은 여분
 * 인자를 조용히 무시하므로 무해하다 [조율자 확인 완료].
 */
export const ARG_KEYS = {
  opts: "opts",
  deviceUID: "deviceUID",
  sampleRate: "sampleRate",
  bufferSize: "bufferSize",
  channels: "channels",
  e2e: "e2e",
  data: "data",
  mark: "mark",
  refWriteId: "refWriteId",
  refChannels: "refChannels",
  outputChannel: "outputChannel",
  outputChannelR: "outputChannelR",
  writeId: "writeId",
  action: "action",
  path: "path",
  totalBytes: "totalBytes",
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
 * 커맨드별 실제 사용 인자(top-level 키) — 런타임에서는 각 호출부가 리터럴 객체를 직접
 * 만들므로 이 맵을 참조하지 않는다. Rust 시그니처와의 diff 문서화 목적.
 * `[ARG_KEYS.opts]`로 표기된 곳은 opts 객체 내부에 어떤 키가 들어가는지 주석으로 병기.
 *
 * - `audio_capture_start` / `audio_playcapture_start`: `data`/`mark` 채널은 e2e 여부와
 *   무관하게 **항상** 함께 전달한다 — `tauri::ipc::Channel`은 Deserialize 미구현이라
 *   `Option<Channel<_>>` 커맨드 인자가 불가능해 Rust 시그니처가 둘 다 필수다(Rust 쪽
 *   audio_capture.rs 주석 참조). e2e=false면 Rust가 mark 채널로 아무것도 안 보낸다.
 * - `audio_playcapture_write_chunk`: JSON 인자 없음 — raw body(Uint8Array) +
 *   `HEADERS.writeId` 헤더로만 전달.
 */
export const COMMAND_ARGS: Record<string, readonly string[]> = {
  [COMMANDS.audioDeviceList]: [],
  [COMMANDS.audioDeviceGetConfig]: [ARG_KEYS.opts], // opts: { deviceUID? }
  [COMMANDS.audioDeviceSetConfig]: [ARG_KEYS.opts], // opts: { sampleRate, bufferSize, deviceUID? }
  [COMMANDS.audioDeviceQuery]: [ARG_KEYS.opts], // opts: { deviceUID? }

  // opts: { sampleRate, bufferSize, channels?, deviceUID?, e2e? }
  [COMMANDS.audioCaptureStart]: [ARG_KEYS.opts, ARG_KEYS.data, ARG_KEYS.mark],
  [COMMANDS.audioCaptureStop]: [],

  [COMMANDS.audioPlayCaptureStartWrite]: [ARG_KEYS.totalBytes], // Rust는 무시 (Electron 원본도 무시)
  [COMMANDS.audioPlayCaptureWriteChunk]: [], // raw body + HEADERS.writeId
  [COMMANDS.audioPlayCaptureFinalizeWrite]: [ARG_KEYS.writeId],
  [COMMANDS.audioPlayCaptureCancelWrite]: [ARG_KEYS.writeId],
  // opts: { sampleRate, bufferSize, channels?, deviceUID?, refWriteId, refChannels?,
  //         outputChannel?, outputChannelR?, e2e? }
  [COMMANDS.audioPlayCaptureStart]: [ARG_KEYS.opts, ARG_KEYS.data, ARG_KEYS.mark],
  [COMMANDS.audioPlayCaptureControl]: [ARG_KEYS.action],
  [COMMANDS.audioPlayCaptureStop]: [],

  [COMMANDS.localFolderSelect]: [],
  [COMMANDS.localFolderUnwatch]: [],
  [COMMANDS.localFolderReadFile]: [ARG_KEYS.path],
};
