//! helper.rs — 과거 Electron IPC 모듈(`electron/ipc/audio-device.js`, 현재는 제거됨)에서
//! 1:1 포팅.
//!
//! Electron 채널 → Tauri 커맨드 매핑:
//!   `audio-device:list`       → `audio_device_list`
//!   `audio-device:get-config` → `audio_device_get_config`
//!   `audio-device:set-config` → `audio_device_set_config`
//!   `audio-device:query`      → `audio_device_query`
//!
//! audio_capture.rs/audio_playcapture.rs도 여기 helper_path()/SUPPORTED/with_device를
//! 재사용한다 — 같은 헬퍼 바이너리와 지원 플랫폼 판정을 공유해야 하기 때문이다(원본 JS와 동일).

use std::path::PathBuf;
use std::process::Command;

/// macOS/Windows만 지원 — 그 외(Linux 포함)는 즉시 unsupported-platform.
/// Windows 헬퍼 실행 파일은 저장소에 커밋되지 않으며, 패키징 전에
/// `native/windows/audio-device-helper/build-win.sh`가 빌드해 생성한다.
pub fn is_supported_platform() -> bool {
    cfg!(target_os = "macos") || cfg!(target_os = "windows")
}

fn helper_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "audio-device-helper.exe"
    } else {
        "audio-device-helper"
    }
}

fn helper_source_dir() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else {
        "macos"
    }
}

/// 헬퍼 바이너리 경로 해석 — 과거 Electron의 `app.isPackaged` 분기를 대체하는 Tauri 쪽 판정.
/// 1) 실행파일 옆의 `audio-device-helper(.exe)` — `bundle.externalBin` 사이드카는
///    빌드 스크립트가 타깃 트리플 접미사를 제거한 이름으로 이 위치에 복사해둔다.
/// 2) 없으면 개발 폴백: `<repo>/native/{macos|windows}/audio-device-helper/dist/…`.
///    repo 루트는 `CARGO_MANIFEST_DIR`(=src-tauri) 기준 한 단계 위 — 컴파일 타임 상수라
///    개발 빌드에서만 의미 있고 배포본에는 존재하지 않아도 무방하다.
pub fn helper_path() -> PathBuf {
    let name = helper_binary_name();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("native")
        .join(helper_source_dir())
        .join("audio-device-helper")
        .join("dist")
        .join(name)
}

/// `--device <UID>` 부착 — deviceUID가 있으면 특정 장치를, 없으면 OS 기본 입력을 대상으로 한다.
pub fn with_device(mut base_args: Vec<String>, device_uid: Option<&str>) -> Vec<String> {
    if let Some(uid) = device_uid {
        base_args.push("--device".to_string());
        base_args.push(uid.to_string());
    }
    base_args
}

/// 헬퍼를 1회성으로 실행하고 stdout을 JSON으로 파싱한다.
/// **절대 Err를 반환하지 않는다** — 렌더러 규약(항상 resolve된 `{success, ...}` 객체)을
/// 지키기 위해 모든 실패 경로가 `{"success": false, "error": "..."}` 값으로 수렴한다.
pub fn run_audio_helper(args: &[String]) -> serde_json::Value {
    if !is_supported_platform() {
        return serde_json::json!({ "success": false, "error": "unsupported-platform" });
    }
    let output = Command::new(helper_path()).args(args).output();
    match output {
        Err(err) => serde_json::json!({ "success": false, "error": err.to_string() }),
        Ok(out) => match serde_json::from_slice::<serde_json::Value>(&out.stdout) {
            Ok(value) => value,
            Err(_) => serde_json::json!({ "success": false, "error": "invalid-helper-output" }),
        },
    }
}
