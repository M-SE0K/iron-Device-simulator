#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio_capture;
mod audio_device;
mod audio_playcapture;
mod file_export;
mod helper;
mod local_folder;
mod streaming;
mod wasm_asset;
mod wasm_key;

use std::sync::Arc;

use tauri::{Manager, RunEvent};

use audio_capture::CaptureState;
use audio_playcapture::PlayCaptureState;
use local_folder::LocalFolderState;
use streaming::StreamController;

const DEVTOOLS_ENABLED: bool = cfg!(any(debug_assertions, feature = "devtools"));

const DEVTOOLS_GUARD_JS: &str = r#"
(() => {
  if (window.__ironDevtoolsGuard) return;
  window.__ironDevtoolsGuard = true;
  const editable = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName));
  window.addEventListener("contextmenu", (e) => {
    if (editable(e.target) || String(window.getSelection() || "")) return;
    e.preventDefault();
  });
  window.addEventListener("keydown", (e) => {
    const k = (e.key || "").toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (
      k === "f12" ||
      (mod && e.shiftKey && ["i", "j", "c"].includes(k)) ||
      (e.metaKey && e.altKey && ["i", "j", "c"].includes(k)) ||
      (e.ctrlKey && k === "u")
    ) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
})();
"#;

fn configure_devtools_access() {
    if DEVTOOLS_ENABLED {
        if let Ok(port) = std::env::var("IRON_REMOTE_DEBUG_PORT") {
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                format!("--remote-debugging-port={port} --remote-allow-origins=*"),
            );
        }
        return;
    }

    std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");

    let hostile_arg = std::env::args()
        .skip(1)
        .any(|a| a.starts_with("--remote-debugging") || a.starts_with("--inspect"));
    if hostile_arg {
        std::process::exit(1);
    }
}

fn main() {
    configure_devtools_access();

    let mut builder = tauri::Builder::default();
    if !DEVTOOLS_ENABLED {
        builder = builder.on_page_load(|webview, _payload| {
            let _ = webview.eval(DEVTOOLS_GUARD_JS);
        });
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(CaptureState(Arc::new(StreamController::new())))
        .manage(PlayCaptureState::new())
        .manage(LocalFolderState::new())
        .invoke_handler(tauri::generate_handler![
            audio_device::audio_device_list,
            audio_device::audio_device_query,
            audio_capture::audio_capture_start,
            audio_capture::audio_capture_stop,
            audio_playcapture::audio_playcapture_start_write,
            audio_playcapture::audio_playcapture_write_chunk,
            audio_playcapture::audio_playcapture_finalize_write,
            audio_playcapture::audio_playcapture_cancel_write,
            audio_playcapture::audio_playcapture_start,
            audio_playcapture::audio_playcapture_write_pcm,
            audio_playcapture::audio_playcapture_control,
            audio_playcapture::audio_playcapture_stop,
            local_folder::local_folder_select,
            local_folder::local_folder_unwatch,
            local_folder::local_folder_read_file,
            file_export::file_export_write_temp,
            file_export::file_export_save,
            wasm_asset::wasm_asset_load,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                cleanup(app_handle);
            }
        });
}

fn cleanup(app: &tauri::AppHandle) {
    let _ = app.state::<CaptureState>().0.stop();
    let _ = app.state::<PlayCaptureState>().controller.stop();
    local_folder::stop_watching(app);
}
