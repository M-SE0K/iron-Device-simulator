#!/usr/bin/env node
// encrypt-wasm.js — WASM 바이너리 하나를 AES-256-GCM으로 암호화한다 (Tauri 패키징 전용,
// scripts/build/stage-encrypted-wasm.sh 가 호출). Node 내장 crypto만 쓴다(신규 의존성 없음).
//
//   node encrypt-wasm.js <in.wasm> <out.enc> <seedfile>
//
// v2: 키는 seedfile(.wasm-seed)에서 derive-wasm-key.js로 파생한다(HKDF-SHA256). GCM은
// AAD로 배포 문맥에 바인딩한다. 출력 포맷: nonce(12B) || ciphertext || tag(16B) —
// src-tauri/src/wasm_asset.rs 가 앞 12바이트를 nonce로, 나머지를 aes-gcm 크레이트의
// decrypt(Payload{msg, aad})에 넘긴다(RustCrypto aes-gcm은 태그가 ciphertext 뒤에 붙은
// 형태를 그대로 받는다).
"use strict";
const fs = require("fs");
const crypto = require("crypto");
const { parseSeed, deriveKey, AAD_CONTEXT } = require("./derive-wasm-key");

const [, , inPath, outPath, seedFilePath] = process.argv;
if (!inPath || !outPath || !seedFilePath) {
  console.error("사용법: node encrypt-wasm.js <in.wasm> <out.enc> <seedfile>");
  process.exit(1);
}

const key = deriveKey(parseSeed(seedFilePath)); // 파일에 저장되지 않는 파생 키

const plaintext = fs.readFileSync(inPath);
const nonce = crypto.randomBytes(12);
const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
cipher.setAAD(AAD_CONTEXT); // 복호화 측과 반드시 동일해야 태그가 맞는다
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const tag = cipher.getAuthTag();

fs.writeFileSync(outPath, Buffer.concat([nonce, ciphertext, tag]));
console.log(
  `✓ 암호화 완료: ${outPath} (평문 ${plaintext.length}B → 암호문 ${nonce.length + ciphertext.length + tag.length}B, AAD 바인딩)`,
);
