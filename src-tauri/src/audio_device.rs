//! audio_device.rs — 오디오 장치 목록 조회/설정 커맨드 4종: `audio_device_list`,
//! `audio_device_get_config`, `audio_device_set_config`, `audio_device_query`.
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

/// 연결된 입력 장치 전체 열거(uid/name/isDefault) — UI 장치 선택 드롭다운용.
///
/// `--no-probe`를 붙이는 이유: 프로브를 켜면 헬퍼가 **설치된 드라이버를 하나씩 전부 연다**
/// (Windows/ASIO는 `loadAsioDriver` + `ASIOInit`, 즉 실제 하드웨어 오픈 — 드라이버당 수백 ms,
/// USB 인터페이스면 초 단위도 흔하다). 드롭다운에 필요한 건 이름/UID뿐이고, 채널 수·샘플레이트는
/// 사용자가 장치를 고른 뒤 `audio_device_query`가 그 장치 하나만 열어서 채운다.
/// 대신 Windows 응답의 `probed`가 항상 false가 되므로, 그걸 "다른 앱이 점유 중"으로 해석하면
/// 안 된다 (CalibrationDrawer.tsx의 드롭다운 힌트 참고).
///
/// 플래그를 Windows에만 붙이는 이유: `--no-probe`는 Windows(ASIO) 헬퍼에만 있는 플래그다.
/// macOS 헬퍼(mac.swift)는 모르는 플래그를 "우연히" 무시할 뿐이고(알려진 플래그만 골라 빼낸 뒤
/// `argv.first`로 커맨드를 읽는데, `list`가 그 앞에 오니 뒤가 안 보인다) 그 동작에 기댈 이유가
/// 없다. CoreAudio 열거는 속성 읽기라 프로브가 비싸지도 않다.
#[tauri::command]
pub async fn audio_device_list() -> Value {
    let mut args = vec!["list".to_string()];
    if cfg!(target_os = "windows") {
        args.push("--no-probe".to_string());
    }
    run_audio_helper(&args)
}

#[tauri::command]
pub async fn audio_device_get_config(opts: Option<Value>) -> Value {
    let uid = device_uid(&opts);
    let args = with_device(vec!["get".to_string()], uid.as_deref());
    run_audio_helper(&args)
}

#[tauri::command]
pub async fn audio_device_set_config(opts: Value) -> Value {
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
pub async fn audio_device_query(opts: Option<Value>) -> Value {
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
