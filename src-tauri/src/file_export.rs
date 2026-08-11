//! file_export.rs — Records의 export(JSON/CSV/V-I 오디오/Protected WAV)가 렌더러의
//! `URL.createObjectURL` + `<a download>` 클릭만으로는 Tauri 네이티브 웹뷰(특히 macOS
//! WKWebView)에서 저장 다이얼로그를 띄우지 못해 새로 추가한 커맨드 — 일반 브라우저는 그대로
//! 기존 앵커 다운로드를 쓰고, Tauri에서만 `shared/lib/utils.ts`의 `downloadBlob()`이 이
//! 커맨드로 우회한다.
//!
//! 두 단계로 나뉘어 있다(`audio_playcapture`의 start_write/write_chunk 핸드셰이크와 같은
//! 이유로 raw body를 쓴다 — JSON/base64로는 큰 WAV export가 느리다):
//!
//!   1. `file_export_write_temp` (sync, raw invoke body) — 바이트를 임시 파일에 그대로 쓴다.
//!   2. `file_export_save` (**반드시 async fn**) — 저장 다이얼로그를 띄우고 임시 파일을
//!      사용자가 고른 위치로 옮긴다.
//!
//! 2번이 async여야 하는 이유(실측으로 확인한 버그, 처음엔 둘 다 하나의 sync 커맨드였다):
//! Tauri의 sync 커맨드는 IPC 콜백과 같은 스레드에서 곧바로 실행되는데, macOS WKWebView는 그
//! 콜백을 **항상 메인 스레드**에서 부른다. `app.dialog().file().blocking_save_file()`은 내부적으로
//! "메인 스레드에 다이얼로그를 여는 클로저를 큐잉 → 완료될 때까지 채널로 대기"하는 구조라,
//! sync 커맨드 안에서 부르면 메인 스레드가 자기 자신이 큐에 넣은 작업을 처리하지 못해 그대로
//! 데드락된다(증상: 저장 다이얼로그의 "저장" 버튼을 눌러도 반응 없음 + macOS가 "응용
//! 프로그램이 응답하지 않습니다"를 띄움). async fn으로 선언하면 Tauri가 커맨드 실행 자체를
//! tokio 워커 스레드로 넘겨서(`InvokeResolver::respond_async`) 메인 스레드가 아닌 곳에서
//! 안전하게 블로킹할 수 있다 — `local_folder_select`가 이미 같은 이유로 async fn +
//! `blocking_pick_folder()` 조합을 쓰고 있다. 반대로 raw invoke body(`Request<'_>`)는 async
//! 커맨드에 못 쓴다(`Request<'a>`가 invoke 호출 스택 프레임을 빌리는 타입이라 tokio::spawn이
//! 요구하는 `'static`과 맞지 않는다) — 그래서 raw body를 받는 1번은 sync로 남겨두고, 다이얼로그를
//! 여는 2번만 별도 async 커맨드로 분리했다.

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

    // rename은 임시 파일과 목적지가 다른 볼륨/파일시스템에 있으면 EXDEV로 실패한다 —
    // 그 경우 복사 후 임시 파일을 지우는 것으로 대체한다.
    if std::fs::rename(&temp_path, &dest).is_err() {
        std::fs::copy(&temp_path, &dest).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&temp_path);
    }

    Ok(serde_json::json!({ "canceled": false, "path": dest.to_string_lossy() }))
}
