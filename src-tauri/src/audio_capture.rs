//! audio_capture.rs — `electron/ipc/audio-capture.js` 1:1 포팅 (네이티브 오디오 캡처, 상주 헬퍼).
//!
//! Electron 채널 → Tauri 커맨드/이벤트 매핑:
//!   `audio-capture:start`    → `audio_capture_start` (data: Channel, e2e: mark Channel)
//!   `audio-capture:stop`     → `audio_capture_stop`
//!   `audio-capture:data`     → `data` 파라미터로 넘긴 Channel (Raw PCM 청크)
//!   `audio-capture:ended`    → `app.emit("audio-capture:ended", { code })`
//!   `audio-capture:e2e-mark` → `mark` 파라미터로 넘긴 Channel (E2E 실험 전용)
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
    // wire 키는 electron-bridge.d.ts 원형(`deviceUID` — 대문자 UID) 그대로. rename_all =
    // "camelCase"는 `deviceUid`를 만들어 shim이 보내는 키와 어긋나므로 명시적으로 재지정한다.
    #[serde(default, rename = "deviceUID")]
    device_uid: Option<String>,
    #[serde(default)]
    e2e: bool,
}

// 참고: `tauri::ipc::Channel`은 `Deserialize`를 구현하지 않아 `Option<Channel<_>>`을 커맨드
// 인자로 쓸 수 없다(CommandArg는 Channel 전용 impl과 `T: Deserialize`용 블랭킷 impl뿐이라 그
// 중간의 `Option<Channel<_>>`엔 아무 impl도 없음 — 실제 `cargo check`로 확인). 그래서 `mark`
// 채널은 **항상 필수 인자**로 받고, 실제로 그 위로 메시지를 보낼지는 `opts.e2e`로만 판단한다.
// (Phase 4 shim 작성자 참고: `audio_capture_start`/`audio_playcapture_start` invoke 시 `mark`
// 채널을 e2e 여부와 무관하게 항상 함께 넘겨야 한다 — e2e가 꺼져 있으면 Rust가 그냥 안 쓴다.)
#[tauri::command]
pub fn audio_capture_start(
    app: AppHandle,
    state: State<'_, CaptureState>,
    opts: CaptureStartOptions,
    data: Channel<InvokeResponseBody>,
    mark: Channel<InvokeResponseBody>,
) -> Value {
    if !is_supported_platform() {
        return serde_json::json!({ "success": false, "error": "unsupported-platform" });
    }
    let controller = state.0.clone();
    if controller.is_running() {
        return serde_json::json!({ "success": false, "error": "capture-already-running" });
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

    // E2E 지연 실험(N1) 전용 — 렌더러가 명시적으로 요청(e2e=true)했을 때만 mark 채널을 쓴다.
    let mark_channel = if opts.e2e { Some(mark) } else { None };

    run_streaming_helper(
        app,
        controller,
        helper_path(),
        args,
        data,
        "audio-capture:ended".to_string(),
        mark_channel,
        None,
    )
}

#[tauri::command]
pub fn audio_capture_stop(state: State<'_, CaptureState>) -> Value {
    state.0.stop()
}
