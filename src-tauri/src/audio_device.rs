//! audio_device.rs — 과거 Electron IPC 모듈(`electron/ipc/audio-device.js`, 현재는 제거됨)의
//! ipcMain.handle 4종을 1:1 포팅.
//!
//! Electron 채널 → Tauri 커맨드 매핑:
//!   `audio-device:list`       → `audio_device_list`
//!   `audio-device:get-config` → `audio_device_get_config`
//!   `audio-device:set-config` → `audio_device_set_config`
//!   `audio-device:query`      → `audio_device_query`
//!
//! 인자/반환 모두 `serde_json::Value` 패스스루 — 헬퍼 CLI 계약이 진짜 소스이므로 여기서
//! 별도 타입을 만들지 않는다. (참고: get/setConfig는 렌더러에서 현재 미사용(죽은 표면)이지만
//! `native-bridge.d.ts` 계약 유지를 위해 그대로 구현한다.)

use crate::helper::{run_audio_helper, with_device};
use serde_json::Value;

fn device_uid(opts: &Option<Value>) -> Option<String> {
    opts.as_ref()
        .and_then(|o| o.get("deviceUID"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// 연결된 입력 장치 전체 열거(uid/name/inputChannels/isDefault) — UI 장치 선택 드롭다운용.
#[tauri::command]
pub fn audio_device_list() -> Value {
    run_audio_helper(&["list".to_string()])
}

#[tauri::command]
pub fn audio_device_get_config(opts: Option<Value>) -> Value {
    let uid = device_uid(&opts);
    let args = with_device(vec!["get".to_string()], uid.as_deref());
    run_audio_helper(&args)
}

#[tauri::command]
pub fn audio_device_set_config(opts: Value) -> Value {
    let sample_rate = opts.get("sampleRate").cloned().unwrap_or(Value::Null);
    let buffer_size = opts.get("bufferSize").cloned().unwrap_or(Value::Null);
    let uid = opts
        .get("deviceUID")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let args = with_device(
        vec![
            "set".to_string(),
            json_to_arg(&sample_rate),
            json_to_arg(&buffer_size),
        ],
        uid.as_deref(),
    );
    run_audio_helper(&args)
}

/// 장치 능력 조회(현재값 + 지원 SampleRate 목록 + Buffer 범위 + 입력 채널 수) — UI 장치 정보 패널용.
#[tauri::command]
pub fn audio_device_query(opts: Option<Value>) -> Value {
    let uid = device_uid(&opts);
    let args = with_device(vec!["query".to_string()], uid.as_deref());
    run_audio_helper(&args)
}

/// JS `String(value)`와 동등하게 동작하도록 숫자/문자열 JSON 값을 CLI 인자 문자열로 변환한다.
fn json_to_arg(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}
