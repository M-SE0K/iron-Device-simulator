use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::ipc::{InvokeBody, Request};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub fn file_export_write_temp(request: Request<'_>) -> Result<Value, String> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => return Err("expected-raw-body".to_string()),
    };
    let seq = TEMP_SEQ.fetch_add(1, Ordering::SeqCst);
    let temp_path = std::env::temp_dir().join(format!("iron-export-{}-{seq}.tmp", std::process::id()));
    std::fs::write(&temp_path, bytes).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "tempPath": temp_path.to_string_lossy() }))
}

#[tauri::command]
pub async fn file_export_save(app: AppHandle, temp_path: String, filename: String) -> Result<Value, String> {
    let temp_path = PathBuf::from(temp_path);
    let picked = app.dialog().file().set_file_name(&filename).blocking_save_file();
    let Some(picked) = picked else {
        let _ = std::fs::remove_file(&temp_path);
        return Ok(serde_json::json!({ "canceled": true }));
    };
    let dest = picked.into_path().map_err(|e| e.to_string())?;

    if std::fs::rename(&temp_path, &dest).is_err() {
        std::fs::copy(&temp_path, &dest).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&temp_path);
    }

    Ok(serde_json::json!({ "canceled": false, "path": dest.to_string_lossy() }))
}
