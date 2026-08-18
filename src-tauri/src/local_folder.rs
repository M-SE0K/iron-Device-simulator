use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use notify_debouncer_mini::notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

const AUDIO_EXTENSIONS: &[&str] = &["wav", "mp3", "m4a", "flac", "ogg", "aac", "wma"];

pub struct LocalFolderState {
    allowed_folder: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>>>,
    watch_generation: AtomicU64,
}

impl LocalFolderState {
    pub fn new() -> Self {
        Self {
            allowed_folder: Mutex::new(None),
            watcher: Mutex::new(None),
            watch_generation: AtomicU64::new(0),
        }
    }
}

impl Default for LocalFolderState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    name: String,
    path: String,
    size: u64,
    mtime_ms: f64,
}

fn is_audio_file(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .is_some_and(|ext| AUDIO_EXTENSIONS.contains(&ext.as_str()))
}

fn scan_audio_folder(folder_path: &Path) -> std::io::Result<Vec<FileEntry>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(folder_path)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_audio_file(&name) {
            continue;
        }
        let metadata = entry.metadata()?;
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0);
        out.push(FileEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            size: metadata.len(),
            mtime_ms,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn stop_watching_folder(state: &LocalFolderState) {
    state.watch_generation.fetch_add(1, Ordering::SeqCst);
    *state.watcher.lock().unwrap() = None;
}

fn start_watching_folder(app: AppHandle, state: &LocalFolderState, folder_path: PathBuf) {
    stop_watching_folder(state);
    let my_generation = state.watch_generation.load(Ordering::SeqCst);
    let watched_path = folder_path.clone();

    let debouncer = new_debouncer(
        Duration::from_millis(250),
        move |result: DebounceEventResult| {
            if result.is_err() {
                return;
            }
            let folder_state = app.state::<LocalFolderState>();
            if folder_state.watch_generation.load(Ordering::SeqCst) != my_generation {
                return;
            }
            match scan_audio_folder(&watched_path) {
                Ok(files) => {
                    let _ = app.emit("local-folder:changed", files);
                }
                Err(_) => {
                    stop_watching_folder(&folder_state);
                    let _ = app.emit("local-folder:changed", Vec::<FileEntry>::new());
                }
            }
        },
    );

    if let Ok(mut debouncer) = debouncer {
        if debouncer
            .watcher()
            .watch(&folder_path, RecursiveMode::NonRecursive)
            .is_ok()
        {
            *state.watcher.lock().unwrap() = Some(debouncer);
        }
    }
}

#[tauri::command]
pub async fn local_folder_select(
    app: AppHandle,
    state: State<'_, LocalFolderState>,
) -> Result<Value, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    let Some(picked) = picked else {
        return Ok(serde_json::json!({ "canceled": true }));
    };
    let folder_path = picked.into_path().map_err(|e| e.to_string())?;

    *state.allowed_folder.lock().unwrap() = Some(folder_path.clone());

    match scan_audio_folder(&folder_path) {
        Ok(files) => {
            start_watching_folder(app.clone(), state.inner(), folder_path.clone());
            Ok(serde_json::json!({
                "canceled": false,
                "folderPath": folder_path.to_string_lossy(),
                "files": files,
            }))
        }
        Err(err) => Ok(serde_json::json!({
            "canceled": false,
            "folderPath": folder_path.to_string_lossy(),
            "files": [],
            "error": err.to_string(),
        })),
    }
}

#[tauri::command]
pub async fn local_folder_unwatch(
    state: State<'_, LocalFolderState>,
) -> Result<Value, String> {
    stop_watching_folder(&state);
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn local_folder_read_file(
    state: State<'_, LocalFolderState>,
    path: String,
) -> Result<Response, String> {
    let allowed = state.allowed_folder.lock().unwrap().clone();
    let Some(allowed) = allowed else {
        return Err("no-folder-connected".to_string());
    };
    let resolved = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let base = allowed.canonicalize().map_err(|e| e.to_string())?;
    if !resolved.starts_with(&base) {
        return Err("invalid-path".to_string());
    }
    let data = std::fs::read(&resolved).map_err(|e| e.to_string())?;
    Ok(Response::new(data))
}

pub fn stop_watching(app: &AppHandle) {
    stop_watching_folder(&app.state::<LocalFolderState>());
}
