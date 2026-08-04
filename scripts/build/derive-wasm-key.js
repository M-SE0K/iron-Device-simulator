#!/usr/bin/env node
// derive-wasm-key.js — WASM 복호화 키 파생 로직의 단일 진실원 (encrypt-wasm.js와
// src-tauri/src/wasm_asset.rs가 반드시 동일한 결과를 내야 한다).
//
// v2 하드닝: 32바이트 AES 키를 바이너리에 상수로 두지 않는다. 대신
//   root = SEED_A XOR SEED_B                (둘 다 랜덤 — 어느 쪽도 키가 아니다)
//   key  = HKDF-SHA256(ikm=root, salt=SALT, info=HKDF_INFO)[0..32]
// 로 런타임에 파생한다. 바이너리에는 "키처럼 보이는" 고엔트로피 32바이트 연속 상수가
// 존재하지 않으므로, grep/엔트로피 스캔이나 "복호화 함수 인자로 넘어가는 포인터 한 줄"
// 만으로 키가 새지 않는다. (⚠️ 이건 정적 분석 비용을 올릴 뿐, 실행 중 메모리에서 파생된
// 키를 덤프하는 동적 공격까지 막지는 못한다 — server-less 구조의 근본 한계.)
//
// GCM은 AAD(연관 데이터)로 배포 문맥에 바인딩한다 — AAD를 모른 채 "그냥 AES-GCM
// 복호화"를 시도하면 태그 검증에서 실패한다.
"use strict";
const fs = require("fs");
const crypto = require("crypto");

// encrypt-wasm.js와 wasm_asset.rs가 공유하는 도메인 상수 — 한 곳이라도 바뀌면 복호 실패.
const HKDF_INFO = Buffer.from("iron-device/ff_prot/wasm-key/v2", "utf8");
const AAD_CONTEXT = Buffer.from(
  "com.irondevice.audiosim.desktop/ff_prot.wasm.enc",
  "utf8",
);

// .wasm-seed(JSON): { seedA:hex(32B), seedB:hex(32B), salt:hex(16B) }
function parseSeed(seedPath) {
  const obj = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const a = Buffer.from(obj.seedA || "", "hex");
  const b = Buffer.from(obj.seedB || "", "hex");
  const salt = Buffer.from(obj.salt || "", "hex");
  if (a.length !== 32 || b.length !== 32 || salt.length !== 16) {
    throw new Error(
      `잘못된 seed: seedA/seedB는 32B, salt는 16B여야 합니다 (실제 ${a.length}/${b.length}/${salt.length}B) — ${seedPath}`,
    );
  }
  return { a, b, salt };
}

function deriveKey({ a, b, salt }) {
  const root = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) root[i] = a[i] ^ b[i];
  // crypto.hkdfSync(digest, ikm, salt, info, keylen) — RFC 5869 (Extract→Expand).
  const okm = crypto.hkdfSync("sha256", root, salt, HKDF_INFO, 32);
  return Buffer.from(okm);
}

module.exports = { parseSeed, deriveKey, HKDF_INFO, AAD_CONTEXT };
