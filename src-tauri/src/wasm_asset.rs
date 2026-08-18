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

const HKDF_INFO: &[u8] = b"iron-device/ff_prot/wasm-key/v2";
const AAD_CONTEXT: &[u8] = b"com.irondevice.audiosim.desktop/ff_prot.wasm.enc";

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
