use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn helper_command(program: &Path) -> Command {
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

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

pub fn with_device(mut base_args: Vec<String>, device_uid: Option<&str>) -> Vec<String> {
    if let Some(uid) = device_uid {
        base_args.push("--device".to_string());
        base_args.push(uid.to_string());
    }
    base_args
}

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
