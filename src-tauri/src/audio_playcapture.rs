//! audio_playcapture.rs — 과거 Electron IPC 모듈(`electron/ipc/audio-playcapture.js`, 현재는
//! 제거됨)에서 1:1 포팅
//! (파일 재생 + V/I 캡처, 상주 play-capture 헬퍼).
//!
//! Electron 채널 → Tauri 커맨드/이벤트 매핑:
//!   `audio-playcapture:start-write`    → `audio_playcapture_start_write`
//!   `audio-playcapture:write-chunk`    → `audio_playcapture_write_chunk` (raw invoke body + `x-write-id` 헤더)
//!   `audio-playcapture:finalize-write` → `audio_playcapture_finalize_write`
//!   `audio-playcapture:cancel-write`   → `audio_playcapture_cancel_write`
//!   `audio-playcapture:start`          → `audio_playcapture_start` (data: Channel, e2e: mark Channel)
//!   `audio-playcapture:control`        → `audio_playcapture_control`
//!   `audio-playcapture:stop`           → `audio_playcapture_stop`
//!   `audio-playcapture:data`           → `data` 파라미터로 넘긴 Channel (Raw PCM 청크)
//!   `audio-playcapture:ended`          → `app.emit("audio-playcapture:ended", { code })`
//!   `audio-playcapture:e2e-mark`       → `mark` 파라미터로 넘긴 Channel (E2E 실험 전용)
//!
//! ref 전달은 청크 핸드셰이크(start-write/write-chunk/finalize-write)다 — 파일 전체를 한 번의
//! IPC로 넘기면(수 분 파일 기준 수십 MB) 순간적으로 렌더러/IPC가 멎는다. 렌더러가 PCM을 작은
//! 조각으로 잘라 순차 전송하고, 여기서는 임시 파일에 동기 write로 받아쓴다 — 동기 write 자체가
//! OS 파이프/파일 버퍼링에 걸리므로 렌더러의 순차 await 루프가 자연스러운 백프레셔를 갖는다
//! (원본 JS의 `stream.write` false→drain 대기와 동등한 효과, 방식만 다르다).
//! 완성된 파일 경로는 writeId로 보관해뒀다가 `start`의 refWriteId로 소비한다.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::Value;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::{AppHandle, State};

use crate::helper::{helper_path, is_supported_platform, with_device};
use crate::streaming::{run_streaming_helper, StreamController};

struct WriteSession {
    path: PathBuf,
    writer: BufWriter<File>,
}

pub struct PlayCaptureState {
    pub controller: Arc<StreamController>,
    write_seq: AtomicU64,
    /// 진행 중인 청크 업로드: writeId -> 임시 파일 + 쓰기 스트림.
    write_sessions: Mutex<HashMap<String, WriteSession>>,
    /// finalize-write 완료, `start`의 소비 대기 중인 ref 파일: writeId -> path.
    finalized_refs: Mutex<HashMap<String, PathBuf>>,
}

impl PlayCaptureState {
    pub fn new() -> Self {
        Self {
            controller: Arc::new(StreamController::new()),
            write_seq: AtomicU64::new(0),
            write_sessions: Mutex::new(HashMap::new()),
            finalized_refs: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for PlayCaptureState {
    fn default() -> Self {
        Self::new()
    }
}

/// 렌더러가 재생 파일 PCM을 청크로 잘라 보내기 시작 — 임시 파일에 대한 쓰기 스트림을 연다.
#[tauri::command]
pub async fn audio_playcapture_start_write(
    state: State<'_, PlayCaptureState>,
) -> Result<Value, String> {
    let seq = state.write_seq.fetch_add(1, Ordering::SeqCst);
    let write_id = format!("{}-{seq}", std::process::id());
    let ref_path = std::env::temp_dir().join(format!("iron-playcap-ref-{write_id}.f32"));

    match File::create(&ref_path) {
        Ok(file) => {
            state.write_sessions.lock().unwrap().insert(
                write_id.clone(),
                WriteSession {
                    path: ref_path,
                    writer: BufWriter::new(file),
                },
            );
            Ok(serde_json::json!({ "success": true, "writeId": write_id }))
        }
        Err(err) => Ok(serde_json::json!({ "success": false, "error": err.to_string() })),
    }
}

/// 청크 하나를 파일에 쓴다 — raw invoke body(`InvokeBody::Raw`) + `x-write-id` 헤더로 세션을 찾는다.
///
/// ⚠️ 이 커맨드만 sync로 남는다 — 형제 커맨드들과 달리 `async fn`으로 못 바꾼다.
/// `Request<'a>`가 invoke 호출 스택 프레임을 빌리는 타입이라 `tokio::spawn`이 요구하는
/// `'static`과 맞지 않기 때문이다(file_export.rs 상단 주석과 동일한 제약, 거기서도 raw body를
/// 받는 커맨드만 sync로 남겼다). 즉 청크 write는 여전히 UI 스레드를 잡는다.
/// 옮기려면 시그니처를 바꿔 body를 `Vec<u8>`로 먼저 복사해 소유해야 한다 — 청크당 4MB 추가
/// 복사가 생기므로 별도 판단이 필요해 이번 변경 범위에서는 제외했다.
#[tauri::command]
pub fn audio_playcapture_write_chunk(
    state: State<'_, PlayCaptureState>,
    request: Request<'_>,
) -> Value {
    let write_id = request
        .headers()
        .get("x-write-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => {
            return serde_json::json!({ "success": false, "error": "unknown-write-id" });
        }
    };

    let mut sessions = state.write_sessions.lock().unwrap();
    let Some(session) = sessions.get_mut(&write_id) else {
        return serde_json::json!({ "success": false, "error": "unknown-write-id" });
    };
    match session.writer.write_all(bytes) {
        Ok(()) => serde_json::json!({ "success": true }),
        Err(err) => serde_json::json!({ "success": false, "error": err.to_string() }),
    }
}

/// 마지막 청크 후 스트림을 닫고, 완성된 경로를 finalizedRefs로 옮긴다 — `start`가 그걸 소비한다.
#[tauri::command]
pub async fn audio_playcapture_finalize_write(
    state: State<'_, PlayCaptureState>,
    write_id: String,
) -> Result<Value, String> {
    let session = state.write_sessions.lock().unwrap().remove(&write_id);
    let Some(session) = session else {
        return Ok(serde_json::json!({ "success": false, "error": "unknown-write-id" }));
    };
    let WriteSession { path, mut writer } = session;
    match writer.flush() {
        Ok(()) => {
            drop(writer); // 파일 핸들을 닫는다 — start()가 곧바로 헬퍼에 읽기용으로 넘긴다.
            state.finalized_refs.lock().unwrap().insert(write_id, path);
            Ok(serde_json::json!({ "success": true }))
        }
        Err(err) => {
            drop(writer);
            let _ = std::fs::remove_file(&path);
            Ok(serde_json::json!({ "success": false, "error": err.to_string() }))
        }
    }
}

/// 업로드 실패/재생 취소 시 진행 중이거나 완료된 세션을 정리해 임시 파일이 남지 않게 한다.
#[tauri::command]
pub async fn audio_playcapture_cancel_write(
    state: State<'_, PlayCaptureState>,
    write_id: String,
) -> Result<Value, String> {
    if let Some(session) = state.write_sessions.lock().unwrap().remove(&write_id) {
        let _ = std::fs::remove_file(&session.path);
    }
    if let Some(path) = state.finalized_refs.lock().unwrap().remove(&write_id) {
        let _ = std::fs::remove_file(&path);
    }
    Ok(serde_json::json!({ "success": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayCaptureStartOptions {
    sample_rate: u32,
    buffer_size: u32,
    #[serde(default)]
    channels: Option<u32>,
    // wire 키는 native-bridge.d.ts 원형(`deviceUID` — 대문자 UID) 그대로. rename_all =
    // "camelCase"는 `deviceUid`를 만들어 shim이 보내는 키와 어긋나므로 명시적으로 재지정한다.
    #[serde(default, rename = "deviceUID")]
    device_uid: Option<String>,
    #[serde(default)]
    ref_write_id: Option<String>,
    /// ref 파일의 채널 수 — 2면 헬퍼가 인터리브 스테레오로 해석해 L/R을 분리한다.
    /// 생략 시 헬퍼 기본값(1=모노).
    #[serde(default)]
    ref_channels: Option<u32>,
    /// 출력 채널 지정 — 생략/0이면 헬퍼 기본값(ch0)이라 안 붙여도 되지만, 명시적으로 넘겨
    /// Calibration의 Output Channel 필드가 항상 실제 헬퍼 호출에 반영됨을 보장한다.
    #[serde(default)]
    output_channel: Option<u32>,
    /// R 출력 채널 — 범위 밖/L과 중복이면 헬퍼가 에러 없이 모노로 폴백한다.
    #[serde(default)]
    output_channel_r: Option<u32>,
    #[serde(default)]
    e2e: bool,
}

// 참고: `Channel`은 `Deserialize`가 없어 `Option<Channel<_>>`을 커맨드 인자로 못 쓴다
// (audio_capture.rs 상단 주석 참고 — `cargo check`로 실측). `mark`는 항상 필수 인자로 받고
// 실제 전송 여부만 `opts.e2e`로 가른다.
// audio_capture_start와 같은 이유로 `async fn` + `Result` — 재생 버튼의 가장 큰 프리즈가
// 여기였다. `run_streaming_helper`가 헬퍼의 첫 줄 JSON을 기다리는 동안(프로세스 생성 → ASIO
// 드라이버 로드 → ASIOInit → 버퍼 생성) sync 커맨드는 UI 스레드를 통째로 잡고 있었다.
#[tauri::command]
pub async fn audio_playcapture_start(
    app: AppHandle,
    state: State<'_, PlayCaptureState>,
    opts: PlayCaptureStartOptions,
    data: Channel<InvokeResponseBody>,
    mark: Channel<InvokeResponseBody>,
) -> Result<Value, String> {
    if !is_supported_platform() {
        return Ok(serde_json::json!({ "success": false, "error": "unsupported-platform" }));
    }
    let controller = state.controller.clone();
    if controller.is_running() {
        return Ok(serde_json::json!({ "success": false, "error": "play-capture-already-running" }));
    }

    // refWriteId가 없거나, 있어도 finalize-write를 거치지 않았으면(=finalizedRefs에 없으면)
    // 진행할 수 없다 — 원본 JS의 `if (!refWriteId || !refPath) return missing-ref-write-id` 그대로.
    let ref_path = match &opts.ref_write_id {
        Some(id) => state.finalized_refs.lock().unwrap().remove(id),
        None => None,
    };
    let Some(ref_path) = ref_path else {
        return Ok(serde_json::json!({ "success": false, "error": "missing-ref-write-id" }));
    };

    let mut base_args = vec![
        "play-capture".to_string(),
        "--ref".to_string(),
        ref_path.to_string_lossy().into_owned(),
        opts.sample_rate.to_string(),
        opts.buffer_size.to_string(),
        // 원본 JS `String(channels || 2)` — 0도 "미지정"과 동일하게 취급해 2로 폴백한다.
        opts.channels.filter(|&c| c != 0).unwrap_or(2).to_string(),
    ];
    if let Some(v) = opts.ref_channels {
        base_args.push("--ref-channels".to_string());
        base_args.push(v.to_string());
    }
    if let Some(v) = opts.output_channel {
        base_args.push("--out-ch".to_string());
        base_args.push(v.to_string());
    }
    if let Some(v) = opts.output_channel_r {
        base_args.push("--out-ch-r".to_string());
        base_args.push(v.to_string());
    }
    let args = with_device(base_args, opts.device_uid.as_deref());

    // E2E 지연 실험(N1) 전용 — 렌더러가 명시적으로 요청(e2e=true)했을 때만 mark 채널을 쓴다.
    let mark_channel = if opts.e2e { Some(mark) } else { None };

    // 재생 완료(code 0) 포함 모든 종료 경로(정상 종료·에러·조기 kill)에서 ref 임시 파일을
    // 정리한다 — 원본의 onChildError/onChildExit 콜백을 합친 것과 동등(Rust에서는 spawn 실패
    // 아니면 exit뿐이라 콜백 하나로 충분).
    let cleanup_path = ref_path.clone();
    let cleanup: Box<dyn FnOnce() + Send> = Box::new(move || {
        let _ = std::fs::remove_file(&cleanup_path);
    });

    Ok(run_streaming_helper(
        app,
        controller,
        helper_path(),
        args,
        data,
        "audio-playcapture:ended".to_string(),
        mark_channel,
        Some(cleanup),
    ))
}

/// pause/resume — 헬퍼 stdin 라인 명령으로 중계. stop은 별도 커맨드(stdin EOF→유예→kill).
#[tauri::command]
pub async fn audio_playcapture_control(
    state: State<'_, PlayCaptureState>,
    action: String,
) -> Result<Value, String> {
    if !state.controller.is_running() {
        return Ok(serde_json::json!({ "success": false, "error": "not-running" }));
    }
    if action != "pause" && action != "resume" {
        return Ok(serde_json::json!({ "success": false, "error": format!("unknown-action: {action}") }));
    }
    match state.controller.write_stdin_line(&format!("{action}\n")) {
        Ok(()) => Ok(serde_json::json!({ "success": true })),
        Err(err) => Ok(serde_json::json!({ "success": false, "error": err })),
    }
}

/// audio_capture_stop과 동일 — stdin EOF 후 최대 200ms 유예 폴링 + reap이라 UI 스레드에서 뺀다.
#[tauri::command]
pub async fn audio_playcapture_stop(
    state: State<'_, PlayCaptureState>,
) -> Result<Value, String> {
    Ok(state.controller.stop())
}
