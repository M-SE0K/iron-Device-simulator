// main.rs — Tauri 앱 합성 루트. `electron/main.js` 대응.
//
// out/(scripts/build/build-static-local.sh 공용 코어 산출물)을 내장 asset 프로토콜
// (`frontendDist: "../out"`)로 그대로 띄운다. 오디오 장치/캡처/로컬 폴더 커맨드는 각
// 모듈(audio_device/audio_capture/audio_playcapture/local_folder)에 있고, 이 파일은
// 플러그인·상태 등록과 앱 라이프사이클(종료 시 자식 프로세스 정리)만 담당한다 —
// electron/main.js의 역할 분담과 동일.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio_capture;
mod audio_device;
mod audio_playcapture;
mod file_export;
mod helper;
mod local_folder;
mod streaming;

use std::sync::Arc;

use tauri::{Manager, RunEvent};

use audio_capture::CaptureState;
use audio_playcapture::PlayCaptureState;
use local_folder::LocalFolderState;
use streaming::StreamController;

fn main() {
    // 외부 측정/자동화 도구가 실제 렌더러(네이티브 오디오 경로)에 DevTools 프로토콜로 붙을 수
    // 있도록 원격 디버깅 포트를 연다. Windows(WebView2)에서만 효과가 있다 — macOS WKWebView는
    // CDP가 없어 미지원(계획서 5.6/7.2, 리스크 2). Builder 생성/실행 전에 설정해야
    // WebView2가 초기화 시점에 읽는다.
    if let Ok(port) = std::env::var("IRON_REMOTE_DEBUG_PORT") {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            format!("--remote-debugging-port={port} --remote-allow-origins=*"),
        );
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(CaptureState(Arc::new(StreamController::new())))
        .manage(PlayCaptureState::new())
        .manage(LocalFolderState::new())
        .invoke_handler(tauri::generate_handler![
            audio_device::audio_device_list,
            audio_device::audio_device_get_config,
            audio_device::audio_device_set_config,
            audio_device::audio_device_query,
            audio_capture::audio_capture_start,
            audio_capture::audio_capture_stop,
            audio_playcapture::audio_playcapture_start_write,
            audio_playcapture::audio_playcapture_write_chunk,
            audio_playcapture::audio_playcapture_finalize_write,
            audio_playcapture::audio_playcapture_cancel_write,
            audio_playcapture::audio_playcapture_start,
            audio_playcapture::audio_playcapture_control,
            audio_playcapture::audio_playcapture_stop,
            local_folder::local_folder_select,
            local_folder::local_folder_unwatch,
            local_folder::local_folder_read_file,
            file_export::file_export_write_temp,
            file_export::file_export_save,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // electron/main.js의 window-all-closed/before-quit 대응 — 상주 헬퍼 자식 프로세스와
            // 폴더 감시자를 정리한다. 단일 창 앱이라 창 닫힘=앱 종료로 단순화(Tauri 기본 동작
            // 그대로 — macOS activate 재생성 로직은 두지 않는다. 계획서 5.6 "단순화 채택" 참고).
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
