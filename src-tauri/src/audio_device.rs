use crate::helper::{run_audio_helper, with_device};
use serde_json::Value;

fn device_uid(opts: &Option<Value>) -> Option<String> {
    opts.as_ref()
        .and_then(|o| o.get("deviceUID"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

#[tauri::command]
pub async fn audio_device_list() -> Value {
    let mut args = vec!["list".to_string()];
    if cfg!(target_os = "windows") {
        args.push("--no-probe".to_string());
    }
    run_audio_helper(&args)
}

#[tauri::command]
pub async fn audio_device_query(opts: Option<Value>) -> Value {
    let uid = device_uid(&opts);
    let args = with_device(vec!["query".to_string()], uid.as_deref());
    run_audio_helper(&args)
}
