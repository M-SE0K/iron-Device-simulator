//! wasm_asset.rs — 암호화된 WASM 엔진 바이너리(`ff_prot.wasm.enc`)를 복호화해 프런트에
//! raw bytes로 돌려준다 (WASM 알고리즘 암호화·난독화 작업의 "방법 5": 소스 난독화(방법 1)
//! /빌드 하드닝(2)/바이너리 스트립(3)/글루 JS 난독화(4)는 native/wasm-engine/build-wasm.sh가
//! 이미 처리했고, 여기서는 그 결과물(.wasm)의 배포 형태만 암호화한다).
//!
//! Tauri는 frontendDist(out/) 를 통째로 패키지에 넣는다 — JS가 fetch를 안 한다고 평문 .wasm이
//! 패키지 안에 안 남는 게 아니다. scripts/build/wasm-encryption/stage-encrypted-wasm.sh가 패키징 전에
//! out/wasm/ff_prot.wasm(평문)을 지우고 암호화된 사본을 `bundle.resources`
//! (src-tauri/tauri.conf.json)로 번들에 넣는다. 앱 기동 시 이 커맨드가 그걸 메모리에서
//! 복호화해 IPC로 넘기면, 프런트(wasm-client.ts)가 emcc 글루의 `Module.wasmBinary`로 바로
//! 먹여 자체 fetch를 우회한다.
//!
//! ⚠️ 서버가 없는 구조라 복호화에 필요한 재료가 결국 이 바이너리 안에 있어야 한다 — 이건
//! 진짜 암호학적 안전성이 아니라 "리버싱 비용을 올리는" 방어다(실행 중 메모리에서 파생된
//! 키를 덤프하는 동적 공격까지 막지는 못한다). v2에서는 아래 세 축으로 정적 분석 비용을
//! 끌어올렸다:
//!   1) 키를 상수로 두지 않는다 — root = SEED_A XOR SEED_B → HKDF-SHA256(salt)로 런타임
//!      파생(derive_key). 바이너리에 "키처럼 보이는" 32바이트 연속 고엔트로피 상수가 없다.
//!   2) GCM에 AAD(배포 문맥)를 바인딩 — AAD 없이 "그냥 복호화"하면 태그 검증 실패.
//!   3) Cargo release 프로파일 strip으로 aes-gcm/hkdf 제네릭 심볼을 제거(스킴 은닉).
//! encrypt-wasm.js / derive-wasm-key.js 와 알고리즘·상수가 반드시 일치해야 한다.
//!
//! local_folder.rs의 local_folder_read_file(raw-response, tauri::ipc::Response)과 동일한
//! 패턴을 따른다.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use hkdf::Hkdf;
use sha2::Sha256;
use tauri::ipc::Response;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

use crate::wasm_key::{WASM_SALT, WASM_SEED_A, WASM_SEED_B};

const ENCRYPTED_RESOURCE_NAME: &str = "ff_prot.wasm.enc";
const PLAIN_RESOURCE_NAME: &str = "ff_prot.wasm";
const NONCE_LEN: usize = 12;

// derive-wasm-key.js 와 문자열 단위로 동일해야 한다 — 하나라도 다르면 복호 실패.
const HKDF_INFO: &[u8] = b"iron-device/ff_prot/wasm-key/v2";
const AAD_CONTEXT: &[u8] = b"com.irondevice.audiosim.desktop/ff_prot.wasm.enc";

/// root = SEED_A XOR SEED_B 를 HKDF-SHA256(salt=SALT, info=HKDF_INFO)로 확장해 32바이트
/// AES-256 키를 파생한다. seed 재료는 wasm_key.rs(빌드 산출물)에 있고 키 자체는 어디에도
/// 저장되지 않는다.
fn derive_key() -> [u8; 32] {
    let mut root = [0u8; 32];
    for i in 0..32 {
        root[i] = WASM_SEED_A[i] ^ WASM_SEED_B[i];
    }
    let hk = Hkdf::<Sha256>::new(Some(WASM_SALT.as_slice()), &root);
    let mut okm = [0u8; 32];
    hk.expand(HKDF_INFO, &mut okm)
        .expect("hkdf expand (32B okm는 SHA-256 상한 내)");
    okm
}

#[tauri::command]
pub async fn wasm_asset_load(app: AppHandle) -> Result<Response, String> {
    // --dev 빌드(scripts/build/wasm-encryption/stage-dev-wasm.sh)는 암호화 없이 평문 리소스를 번들에
    // 넣는다. 배포 빌드는 이 리소스를 아예 만들지 않으므로 여기서 평문을 먼저 찾고, 없으면
    // 기존 암호화 경로로 넘어간다 — 두 빌드 변형이 같은 바이너리/커맨드를 공유한다.
    if let Ok(plain_path) = app
        .path()
        .resolve(PLAIN_RESOURCE_NAME, BaseDirectory::Resource)
    {
        if let Ok(plain) = std::fs::read(&plain_path) {
            return Ok(Response::new(plain));
        }
    }

    let resource_path = app
        .path()
        .resolve(ENCRYPTED_RESOURCE_NAME, BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    let blob = std::fs::read(&resource_path).map_err(|e| e.to_string())?;
    if blob.len() < NONCE_LEN {
        return Err("encrypted-wasm-too-short".to_string());
    }
    let (nonce_bytes, ciphertext) = blob.split_at(NONCE_LEN);

    let derived = derive_key();
    let key = Key::<Aes256Gcm>::from_slice(&derived);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(
            nonce,
            Payload {
                msg: ciphertext,
                aad: AAD_CONTEXT,
            },
        )
        .map_err(|_| "wasm-decrypt-failed".to_string())?;

    Ok(Response::new(plaintext))
}
