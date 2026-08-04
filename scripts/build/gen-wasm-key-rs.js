#!/usr/bin/env node
// gen-wasm-key-rs.js — .wasm-seed(JSON)의 seed 재료를 src-tauri/src/wasm_key.rs 의
// 상수 배열 리터럴로 옮겨 적는다. stage-encrypted-wasm.sh 전용.
//
//   node gen-wasm-key-rs.js <seedfile> <out-wasm_key.rs>
//
// v2: AES 키 자체가 아니라 seed 재료(SEED_A/SEED_B/SALT)만 기록한다 — 실제 키는
// wasm_asset.rs가 root = A XOR B → HKDF-SHA256(salt)로 런타임 파생한다(derive-wasm-key.js와
// 동일 알고리즘). 바이너리에 "키처럼 보이는" 연속 상수를 남기지 않기 위함.
"use strict";
const fs = require("fs");
const { parseSeed } = require("./derive-wasm-key");

const [, , seedFilePath, outPath] = process.argv;
if (!seedFilePath || !outPath) {
  console.error("사용법: node gen-wasm-key-rs.js <seedfile> <out-wasm_key.rs>");
  process.exit(1);
}

const { a, b, salt } = parseSeed(seedFilePath);
const arr = (buf) => Array.from(buf, (x) => "0x" + x.toString(16).padStart(2, "0")).join(", ");

const rs = `// wasm_key.rs — scripts/build/stage-encrypted-wasm.sh 가 생성하는 빌드 산출물. git 제외
// (.gitignore). native/wasm-engine/.wasm-seed 와 항상 짝을 이뤄야 한다.
//
// v2: 여기 있는 건 AES 키가 "아니다". wasm_asset.rs가 root = SEED_A XOR SEED_B →
// HKDF-SHA256(ikm=root, salt=SALT)로 복호화 키를 런타임 파생한다. 바이너리에 32바이트
// 고엔트로피 연속 상수(=키)를 두지 않아 grep/엔트로피 스캔·단일 포인터 추적으로 키가
// 바로 새지 않게 한다. 서버 없는 구조라 파생에 필요한 재료가 결국 바이너리 안에 있어야
// 하므로 이건 "정적 분석 비용을 올리는" 방어이지 암호학적 완전 차단이 아니다.
pub const WASM_SEED_A: [u8; 32] = [${arr(a)}];
pub const WASM_SEED_B: [u8; 32] = [${arr(b)}];
pub const WASM_SALT: [u8; 16] = [${arr(salt)}];
`;

fs.writeFileSync(outPath, rs);
console.log(`✓ ${outPath} 작성 완료 (seed 재료 기록, 키는 런타임 파생)`);
