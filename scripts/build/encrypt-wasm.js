#!/usr/bin/env node
// encrypt-wasm.js — WASM 바이너리 하나를 AES-256-GCM으로 암호화한다 (Tauri 패키징 전용,
// scripts/build/stage-encrypted-wasm.sh 가 호출). Node 내장 crypto만 쓴다(신규 의존성 없음).
//
//   node encrypt-wasm.js <in.wasm> <out.enc> <keyfile-hex>
//
// 출력 포맷: nonce(12B) || ciphertext || tag(16B) — src-tauri/src/wasm_asset.rs 가
// 앞 12바이트를 nonce로, 나머지를 aes-gcm 크레이트의 decrypt()에 그대로 넘긴다
// (RustCrypto aes-gcm은 태그가 ciphertext 뒤에 붙은 형태를 그대로 받는다).
const fs = require("fs");
const crypto = require("crypto");

const [, , inPath, outPath, keyFilePath] = process.argv;
if (!inPath || !outPath || !keyFilePath) {
  console.error("사용법: node encrypt-wasm.js <in.wasm> <out.enc> <keyfile-hex>");
  process.exit(1);
}

const keyHex = fs.readFileSync(keyFilePath, "utf8").trim();
const key = Buffer.from(keyHex, "hex");
if (key.length !== 32) {
  console.error(`✗ 키 길이가 32바이트가 아닙니다 (hex 64자 필요, 실제 ${key.length}바이트) — ${keyFilePath}`);
  process.exit(1);
}

const plaintext = fs.readFileSync(inPath);
const nonce = crypto.randomBytes(12);
const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const tag = cipher.getAuthTag();

fs.writeFileSync(outPath, Buffer.concat([nonce, ciphertext, tag]));
console.log(`✓ 암호화 완료: ${outPath} (평문 ${plaintext.length}B → 암호문 ${nonce.length + ciphertext.length + tag.length}B)`);
