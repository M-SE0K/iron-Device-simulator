// main.rs — Tauri 앱 합성 루트 (과거 Electron의 `electron/main.js`가 하던 역할, 현재는 제거됨).
//
// out/(scripts/build/build-static-local.sh 공용 코어 산출물)을 내장 asset 프로토콜
// (`frontendDist: "../out"`)로 그대로 띄운다. 오디오 장치/캡처/로컬 폴더 커맨드는 각
// 모듈(audio_device/audio_capture/audio_playcapture/local_folder)에 있고, 이 파일은
// 플러그인·상태 등록, 앱 라이프사이클(종료 시 자식 프로세스 정리), 그리고 배포 빌드의
// DevTools 차단(configure_devtools_access + DEVTOOLS_GUARD_JS)만 담당한다.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio_capture;
mod audio_device;
mod audio_playcapture;
mod file_export;
mod helper;
mod local_folder;
mod streaming;
mod wasm_asset;
// wasm_key.rs는 scripts/build/stage-encrypted-wasm.sh 가 빌드 시점에 생성하는 산출물이다
// (git 제외) — 없으면 이 mod 선언에서 cargo build가 실패한다(externalBin 오디오 헬퍼 바이너리를
// build-tauri.sh가 미리 배치해야 하는 것과 같은 패턴). wasm_asset.rs가 WASM_KEY를 참조한다.
mod wasm_key;

use std::sync::Arc;

use tauri::{Manager, RunEvent};

use audio_capture::CaptureState;
use audio_playcapture::PlayCaptureState;
use local_folder::LocalFolderState;
use streaming::StreamController;

/// 이 빌드에 DevTools(WebView 인스펙터)가 포함되는지.
///
/// `tauri`/`wry`는 `any(debug_assertions, feature = "devtools")`일 때만 인스펙터를 컴파일하고
/// 웹뷰에 켠다(WKWebView `isInspectable` / WebView2 `AreDevToolsEnabled`). 즉 배포 빌드
/// (`npm run build:tauri`)는 이 상수가 false이고, 인스펙터는 코드에 존재하지도 않는다.
/// 측정용으로 열려면 `--devtools`로 빌드한다(Cargo.toml의 `[features] devtools` 주석 참고).
const DEVTOOLS_ENABLED: bool = cfg!(any(debug_assertions, feature = "devtools"));

/// 배포 빌드에서 웹뷰에 주입하는 가드 스크립트.
///
/// 인스펙터가 빌드에서 빠져 있으면 F12/Cmd+Opt+I는 원래도 아무 일이 없고 컨텍스트 메뉴에
/// "검사" 항목도 나오지 않는다 — 이건 그 위에 얹는 이중 안전장치이자, 인스펙터와 무관하게
/// 남아 있는 WebView2 기본 컨텍스트 메뉴의 "다른 이름으로 저장"·Ctrl+U(소스 보기)처럼
/// 페이지를 통째로 뽑아가는 경로를 같이 막기 위한 것이다.
///
/// 입력 필드 안이나 텍스트를 선택한 상태에서는 컨텍스트 메뉴를 그대로 둔다 — Calibration
/// 입력값 복사·붙여넣기 UX까지 죽일 이유는 없다.
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

/// DevTools/원격 디버깅으로 붙는 "인스펙터 바깥" 경로를 빌드 종류에 따라 열거나 막는다.
/// `tauri::Builder`를 만들기 전에 불러야 한다 — WebView2 인자는 웹뷰 초기화 시점에 읽힌다.
fn configure_devtools_access() {
    if DEVTOOLS_ENABLED {
        // 측정/개발 빌드에서만: 외부 측정·자동화 도구가 실제 렌더러(네이티브 오디오 경로)에
        // DevTools 프로토콜로 붙을 수 있도록 원격 디버깅 포트를 연다. Windows(WebView2)에서만
        // 효과가 있다 — macOS WKWebView는 CDP가 없어 미지원(계획서 5.6/7.2, 리스크 2).
        if let Ok(port) = std::env::var("IRON_REMOTE_DEBUG_PORT") {
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                format!("--remote-debugging-port={port} --remote-allow-origins=*"),
            );
        }
        return;
    }

    // ── 배포 빌드 ──────────────────────────────────────────────────────────────
    // 위 블록을 타지 않으므로 IRON_REMOTE_DEBUG_PORT는 그대로 무시된다. 더해서, 밖에서 미리
    // 넣어둔 WebView2 인자도 통째로 지운다. 지금 wry(0.55)는 이 환경변수를 읽지 않고 자기가
    // 만든 인자 문자열을 명시적으로 넘기지만, 상위 계층이 바뀌어 다시 읽게 되더라도
    // `--remote-debugging-port`가 새어 들어가지 않게 여기서 먼저 비운다.
    std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");

    // `open -a "..." --args --remote-debugging-port=9222` 처럼 명령줄로 붙이는 경로는 실행
    // 자체를 막는다. 웹뷰가 뜨기 전에 종료되므로 포트가 열릴 여지가 없다.
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
        // 페이지 로드마다(Started/Finished 양쪽) 주입한다 — 스크립트 자체가 `__ironDevtoolsGuard`
        // 플래그로 멱등이라 두 번 실행돼도 리스너가 중복되지 않는다.
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
            wasm_asset::wasm_asset_load,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 앱 종료 시(과거 Electron의 window-all-closed/before-quit 대응) 상주 헬퍼 자식
            // 프로세스와 폴더 감시자를 정리한다. 단일 창 앱이라 창 닫힘=앱 종료로 단순화(Tauri 기본 동작
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
