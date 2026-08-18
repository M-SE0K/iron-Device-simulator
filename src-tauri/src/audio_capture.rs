use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};

use crate::helper::{helper_path, is_supported_platform, with_device};
use crate::streaming::{run_streaming_helper, StreamController};

pub struct CaptureState(pub Arc<StreamController>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStartOptions {
    sample_rate: u32,
    buffer_size: u32,
    #[serde(default)]
    channels: Option<u32>,
    #[serde(default, rename = "deviceUID")]
    device_uid: Option<String>,
}

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

#[tauri::command]
pub async fn audio_capture_stop(state: State<'_, CaptureState>) -> Result<Value, String> {
    Ok(state.0.stop())
}
