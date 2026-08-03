//! wasm_asset.rs — 암호화된 WASM 엔진 바이너리(`ff_prot.wasm.enc`)를 복호화해 프런트에
//! raw bytes로 돌려준다 (WASM 알고리즘 암호화·난독화 작업의 "방법 5": 소스 난독화(방법 1)
//! /빌드 하드닝(2)/바이너리 스트립(3)/글루 JS 난독화(4)는 native/wasm-engine/build-wasm.sh가
//! 이미 처리했고, 여기서는 그 결과물(.wasm)의 배포 형태만 암호화한다).
//!
//! Tauri는 frontendDist(out/) 를 통째로 패키지에 넣는다 — JS가 fetch를 안 한다고 평문 .wasm이
//! 패키지 안에 안 남는 게 아니다. scripts/build/stage-encrypted-wasm.sh가 패키징 전에
//! out/wasm/ff_prot.wasm(평문)을 지우고 암호화된 사본을 `bundle.resources`
//! (src-tauri/tauri.conf.json)로 번들에 넣는다. 앱 기동 시 이 커맨드가 그걸 메모리에서
//! 복호화해 IPC로 넘기면, 프런트(wasm-client.ts)가 emcc 글루의 `Module.wasmBinary`로 바로
//! 먹여 자체 fetch를 우회한다.
//!
//! ⚠️ 서버가 없는 구조라 복호화 키(wasm_key.rs, gitignore)가 결국 이 바이너리 안에 있어야
//! 한다 — 이건 진짜 암호학적 안전성이 아니라 "평문 .wasm 파일 하나를 파일탐색기로 그냥
//! 꺼내가는 것"을 막는 수준의 방어다. 목표는 완전 차단이 아니라 리버싱 비용을 올리는 것.
//!
//! local_folder.rs의 local_folder_read_file(raw-response, tauri::ipc::Response)과 동일한
//! 패턴을 따른다.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use tauri::ipc::Response;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

use crate::wasm_key::WASM_KEY;

const ENCRYPTED_RESOURCE_NAME: &str = "ff_prot.wasm.enc";
const NONCE_LEN: usize = 12;

#[tauri::command]
pub async fn wasm_asset_load(app: AppHandle) -> Result<Response, String> {
    let resource_path = app
        .path()
        .resolve(ENCRYPTED_RESOURCE_NAME, BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    let blob = std::fs::read(&resource_path).map_err(|e| e.to_string())?;
    if blob.len() < NONCE_LEN {
        return Err("encrypted-wasm-too-short".to_string());
    }
    let (nonce_bytes, ciphertext) = blob.split_at(NONCE_LEN);

    let key = Key::<Aes256Gcm>::from_slice(&WASM_KEY);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "wasm-decrypt-failed".to_string())?;

    Ok(Response::new(plaintext))
}
