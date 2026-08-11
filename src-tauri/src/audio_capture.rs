//! audio_capture.rs — 네이티브 오디오 캡처(상주 헬퍼) 커맨드/이벤트: `audio_capture_start`
//! (data: Channel — Raw PCM 청크), `audio_capture_stop`,
//! `app.emit("audio-capture:ended", { code })`.
//!
//! `capture` 모드는 헬퍼가 캡처 I/O(IOProc)를 직접 열어 BufferFrameSize의 주인이 되므로
//! 1회성 set과 달리 요청한 버퍼 크기가 실제 적용·유지된다(native/macos/audio-device-helper/
//! README.md 참고). 헬퍼 stdout: 첫 줄 JSON 헤더 → 이후 int16 인터리브 raw PCM — 청크를 그대로
//! 렌더러(Channel)에 중계한다.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};

use crate::helper::{helper_path, is_supported_platform, with_device};
use crate::streaming::{run_streaming_helper, StreamController};

/// `audio_capture_start`/`audio_capture_stop`가 공유하는 상주 자식 프로세스 상태.
/// `main.rs`가 `Arc<StreamController>`로 감싸 `manage()`한다(스트리밍 리더 스레드가
/// 'static 수명으로 접근해야 하므로).
pub struct CaptureState(pub Arc<StreamController>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStartOptions {
    sample_rate: u32,
    buffer_size: u32,
    #[serde(default)]
    channels: Option<u32>,
    // wire 키는 native-bridge.d.ts 원형(`deviceUID` — 대문자 UID) 그대로. rename_all =
    // "camelCase"는 `deviceUid`를 만들어 shim이 보내는 키와 어긋나므로 명시적으로 재지정한다.
    #[serde(default, rename = "deviceUID")]
    device_uid: Option<String>,
}

// `async fn` + `Result`인 이유: sync 커맨드는 IPC 디스패치 스레드(Windows/WebView2에서는 UI
// 스레드)에서 **인라인**으로 실행된다(tauri-macros `body_blocking`). 이 커맨드는
// `run_streaming_helper` 안에서 헬퍼가 첫 줄 JSON 헤더를 뱉을 때까지 블로킹하는데, 그 사이
// 헬퍼는 프로세스 생성 → 드라이버 로드 → 드라이버 init → 버퍼 생성을 한다(ASIO는 수백 ms~초).
// sync로 두면 그동안 창 전체가 얼어붙는다. `async fn`으로 선언하면 Tauri가 커맨드 실행을
// tokio 워커로 넘겨(`respond_async_serialized`) UI 스레드가 풀린다.
// `State<'_>`처럼 빌린 인자를 받는 async 커맨드는 Rust 수명 추론 한계로 반환 타입이 `Result`여야
// 하므로 항상 `Ok(...)`를 돌려준다 — JS 쪽 계약(`{success, ...}` 값으로 resolve)은 그대로다.
#[tauri::command]
pub async fn audio_capture_start(
    app: AppHandle,
    state: State<'_, CaptureState>,
    opts: CaptureStartOptions,
    data: Channel<InvokeResponseBody>,
) -> Result<Value, String> {
    if !is_supported_platform() {
        return Ok(serde_json::json!({ "success": false, "error": "unsupported-platform" }));
    }
    let controller = state.0.clone();
    if controller.is_running() {
        return Ok(serde_json::json!({ "success": false, "error": "capture-already-running" }));
    }

    let args = with_device(
        vec![
            "capture".to_string(),
            opts.sample_rate.to_string(),
            opts.buffer_size.to_string(),
            // 원본 JS `String(channels || 2)` — 0도 "미지정"과 동일하게 취급해 2로 폴백한다.
            opts.channels.filter(|&c| c != 0).unwrap_or(2).to_string(),
        ],
        opts.device_uid.as_deref(),
    );

    Ok(run_streaming_helper(
        app,
        controller,
        helper_path(),
        args,
        data,
        "audio-capture:ended".to_string(),
        None,
    ))
}

/// stop도 async — `StreamController::stop()`이 stdin EOF 후 최대 200ms 유예를 폴링하며 기다리고
/// (`stop_streaming_child`) 이어서 `child.wait()`로 reap한다. UI 스레드에서 할 일이 아니다.
#[tauri::command]
pub async fn audio_capture_stop(state: State<'_, CaptureState>) -> Result<Value, String> {
    Ok(state.0.stop())
}
