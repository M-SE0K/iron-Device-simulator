//! helper.rs — 네이티브 오디오 헬퍼 바이너리 실행/경로 해석 공용 로직.
//!
//! audio_capture.rs/audio_playcapture.rs도 여기 helper_path()/SUPPORTED/with_device를
//! 재사용한다 — 같은 헬퍼 바이너리와 지원 플랫폼 판정을 공유해야 하기 때문이다.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Windows에서 자식 콘솔 창이 열리지 않게 하는 CreateProcess 플래그.
/// `windows` 크레이트를 끌어오지 않으려고 상수를 직접 둔다(winbase.h `CREATE_NO_WINDOW`).
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 헬퍼 실행용 `Command`를 만든다 — 헬퍼를 띄우는 모든 경로(1회성 `run_audio_helper`,
/// 상주 `streaming::run_streaming_helper`)가 반드시 이걸 거쳐야 한다.
///
/// 헬퍼는 콘솔 서브시스템 exe인데 앱 본체는 `windows_subsystem = "windows"`(main.rs)라
/// 콘솔이 없다. 그래서 플래그 없이 띄우면 호출마다 새 콘솔 창이 잠깐 열렸다 닫힌다 —
/// 화면 깜빡임은 물론이고 콘솔 할당 자체가 공짜가 아니다. macOS/Linux는 해당 없음.
pub fn helper_command(program: &Path) -> Command {
    // Windows 외 타깃에서는 아래 cfg 블록이 통째로 사라져 `mut`가 남아돈다.
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

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

/// 헬퍼 바이너리 경로 해석 — 패키징 여부에 따른 분기.
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
    let output = helper_command(&helper_path()).args(args).output();
    match output {
        Err(err) => serde_json::json!({ "success": false, "error": err.to_string() }),
        Ok(out) => match serde_json::from_slice::<serde_json::Value>(&out.stdout) {
            Ok(value) => value,
            Err(_) => serde_json::json!({ "success": false, "error": "invalid-helper-output" }),
        },
    }
}
