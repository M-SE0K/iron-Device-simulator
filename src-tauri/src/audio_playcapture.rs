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
    write_sessions: Mutex<HashMap<String, WriteSession>>,
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
            drop(writer);
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
    #[serde(default, rename = "deviceUID")]
    device_uid: Option<String>,
    #[serde(default)]
    ref_write_id: Option<String>,
    #[serde(default)]
    ref_channels: Option<u32>,
    #[serde(default)]
    output_channel: Option<u32>,
    #[serde(default)]
    output_channel_r: Option<u32>,
    #[serde(default)]
    stream: Option<bool>,
    #[serde(default)]
    prefill_ms: Option<u32>,
}

#[tauri::command]
pub async fn audio_playcapture_start(
    app: AppHandle,
    state: State<'_, PlayCaptureState>,
    opts: PlayCaptureStartOptions,
    data: Channel<InvokeResponseBody>,
) -> Result<Value, String> {
    if !is_supported_platform() {
        return Ok(serde_json::json!({ "success": false, "error": "unsupported-platform" }));
    }
    let controller = state.controller.clone();
    if controller.is_running() {
        return Ok(serde_json::json!({ "success": false, "error": "play-capture-already-running" }));
    }

    let stream_mode = opts.stream.unwrap_or(false);
    let ref_path = if stream_mode {
        None
    } else {
        let path = match &opts.ref_write_id {
            Some(id) => state.finalized_refs.lock().unwrap().remove(id),
            None => None,
        };
        let Some(path) = path else {
            return Ok(serde_json::json!({ "success": false, "error": "missing-ref-write-id" }));
        };
        Some(path)
    };

    let mut base_args = vec!["play-capture".to_string()];
    match &ref_path {
        Some(path) => {
            base_args.push("--ref".to_string());
            base_args.push(path.to_string_lossy().into_owned());
        }
        None => base_args.push("--stream".to_string()),
    }
    base_args.push(opts.sample_rate.to_string());
    base_args.push(opts.buffer_size.to_string());
    base_args.push(opts.channels.filter(|&c| c != 0).unwrap_or(2).to_string());
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
    if stream_mode {
        if let Some(v) = opts.prefill_ms {
            base_args.push("--prefill-ms".to_string());
            base_args.push(v.to_string());
        }
    }
    let args = with_device(base_args, opts.device_uid.as_deref());

    let cleanup: Option<Box<dyn FnOnce() + Send>> = ref_path.map(|path| {
        Box::new(move || {
            let _ = std::fs::remove_file(&path);
        }) as Box<dyn FnOnce() + Send>
    });

    Ok(run_streaming_helper(
        app,
        controller,
        helper_path(),
        args,
        data,
        "audio-playcapture:ended".to_string(),
        cleanup,
    ))
}

#[tauri::command]
pub fn audio_playcapture_write_pcm(
    state: State<'_, PlayCaptureState>,
    request: Request<'_>,
) -> Value {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => {
            return serde_json::json!({ "success": false, "error": "invalid-pcm-body" });
        }
    };
    if bytes.is_empty() {
        return serde_json::json!({ "success": true });
    }
    let mut framed = Vec::with_capacity(bytes.len() + 16);
    framed.extend_from_slice(format!("pcm {}\n", bytes.len()).as_bytes());
    framed.extend_from_slice(bytes);
    match state.controller.write_stdin_bytes(&framed) {
        Ok(()) => serde_json::json!({ "success": true }),
        Err(err) => serde_json::json!({ "success": false, "error": err }),
    }
}

#[tauri::command]
pub async fn audio_playcapture_control(
    state: State<'_, PlayCaptureState>,
    action: String,
) -> Result<Value, String> {
    if !state.controller.is_running() {
        return Ok(serde_json::json!({ "success": false, "error": "not-running" }));
    }
    if action != "pause" && action != "resume" && action != "end" {
        return Ok(serde_json::json!({ "success": false, "error": format!("unknown-action: {action}") }));
    }
    match state.controller.write_stdin_line(&format!("{action}\n")) {
        Ok(()) => Ok(serde_json::json!({ "success": true })),
        Err(err) => Ok(serde_json::json!({ "success": false, "error": err })),
    }
}

#[tauri::command]
pub async fn audio_playcapture_stop(
    state: State<'_, PlayCaptureState>,
) -> Result<Value, String> {
    Ok(state.controller.stop())
}
