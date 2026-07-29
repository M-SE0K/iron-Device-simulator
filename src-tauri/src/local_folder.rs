//! local_folder.rs — `electron/ipc/local-folder.js` 1:1 포팅 (워크스페이스 "로컬 폴더" 기능).
//!
//! Electron 채널 → Tauri 커맨드/이벤트 매핑:
//!   `local-folder:select`    → `local_folder_select`
//!   `local-folder:unwatch`   → `local_folder_unwatch`
//!   `local-folder:read-file` → `local_folder_read_file` (raw 응답 — `tauri::ipc::Response`)
//!   `local-folder:changed`   → `app.emit("local-folder:changed", files)`
//!
//! 사용자가 고른 폴더 안의 오디오 파일만 나열하고, `notify`(+250ms 디바운스)로 변경을 감시해
//! 렌더러에 목록을 다시 밀어준다. 파일 읽기는 마지막으로 select()된 폴더(allowed_folder)
//! 하위 경로만 허용해 임의 경로 읽기를 막는다.

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
    /// 진행 중인 감시 인스턴스 식별자 — `stop_watching_folder`/`start_watching_folder`를 부를
    /// 때마다 증가한다. 디바운스 콜백은 자신이 시작될 때의 값을 기억해뒀다가, 콜백이 실제로
    /// 실행되는 시점에 그 값이 여전히 최신인지 확인한다(원본 JS `watchedFolderPath !== folderPath`
    /// 가드와 동일 의도 — Rust에서는 `Debouncer` drop이 스레드 종료를 비동기로 신호만 하므로,
    /// drop 직후 아주 잠깐 옛 콜백이 실행될 수 있는 경합을 이 세대 비교로 막는다).
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
    /// JS 계약: 밀리초 단위 f64 (Date.prototype.getTime()과 동일 단위).
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
    // 원본 JS는 `localeCompare` — 로캘 인지 정렬. 별도 크레이트 없이는 동등 구현이 번거로워
    // 바이트 순서 비교로 대체한다(파일명이 대개 ASCII인 오디오 라이브러리 특성상 체감차 적음).
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn stop_watching_folder(state: &LocalFolderState) {
    state.watch_generation.fetch_add(1, Ordering::SeqCst);
    *state.watcher.lock().unwrap() = None; // Drop이 디바운서 내부 스레드에 종료 신호를 보낸다.
}

fn start_watching_folder(app: AppHandle, state: &LocalFolderState, folder_path: PathBuf) {
    stop_watching_folder(state);
    let my_generation = state.watch_generation.load(Ordering::SeqCst);
    let watched_path = folder_path.clone();

    let debouncer = new_debouncer(
        Duration::from_millis(250),
        move |result: DebounceEventResult| {
            if result.is_err() {
                return; // notify 백엔드 자체 에러 — 원본에 대응 없음, 무시.
            }
            let folder_state = app.state::<LocalFolderState>();
            if folder_state.watch_generation.load(Ordering::SeqCst) != my_generation {
                return; // 이 감시는 이미 교체/중단됐다 — 스테일 콜백 무시.
            }
            match scan_audio_folder(&watched_path) {
                Ok(files) => {
                    let _ = app.emit("local-folder:changed", files);
                }
                Err(_) => {
                    // 폴더가 삭제/이동된 경우 등 — 감시를 중단하고 빈 목록을 알린다.
                    // Debouncer::drop은 종료 신호만 비동기로 보내므로 지금 실행 중인 이 콜백
                    // 자신을 안전하게 정지시킬 수 있다(스레드 join 없이 바로 반환됨).
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
        // watch() 실패 시 debouncer는 그냥 drop되어 정리된다 — 원본도 fs.watch 실패를 별도
        // 처리하지 않는다(예외가 select() 호출자에게 전파될 뿐).
    }
}

#[tauri::command]
pub async fn local_folder_select(
    app: AppHandle,
    state: State<'_, LocalFolderState>,
) -> Result<Value, String> {
    // tauri-plugin-dialog의 자체 커맨드 구현(commands.rs)도 async 커맨드 안에서 그대로
    // blocking_pick_folder를 부른다 — sync 커맨드는 Tauri가 전용 블로킹 스레드에서 실행하므로
    // 여기서 스레드를 막아도 async 런타임 전체는 막히지 않는다.
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
pub fn local_folder_unwatch(state: State<'_, LocalFolderState>) -> Value {
    stop_watching_folder(&state);
    serde_json::json!({ "success": true })
}

#[tauri::command]
pub fn local_folder_read_file(
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

/// main.rs의 앱 라이프사이클(ExitRequested/Exit) 정리 훅이 호출한다.
pub fn stop_watching(app: &AppHandle) {
    stop_watching_folder(&app.state::<LocalFolderState>());
}
