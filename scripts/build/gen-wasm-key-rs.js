#!/usr/bin/env node
// gen-wasm-key-rs.js — 32바이트 hex 키 파일을 src-tauri/src/wasm_key.rs 의
// `pub const WASM_KEY: [u8; 32]` 배열 리터럴로 옮겨 적는다. stage-encrypted-wasm.sh 전용.
//
//   node gen-wasm-key-rs.js <keyfile-hex> <out-wasm_key.rs>
const fs = require("fs");

const [, , keyFilePath, outPath] = process.argv;
if (!keyFilePath || !outPath) {
  console.error("사용법: node gen-wasm-key-rs.js <keyfile-hex> <out-wasm_key.rs>");
  process.exit(1);
}

const hex = fs.readFileSync(keyFilePath, "utf8").trim();
if (hex.length !== 64) {
  console.error(`✗ 키 길이가 32바이트(hex 64자)가 아닙니다 (실제 ${hex.length}자) — ${keyFilePath}`);
  process.exit(1);
}

const bytes = [];
for (let i = 0; i < hex.length; i += 2) bytes.push("0x" + hex.slice(i, i + 2));

const rs = `// wasm_key.rs — scripts/build/stage-encrypted-wasm.sh 가 생성하는 빌드 산출물. git 제외
// (.gitignore). native/wasm-engine/.wasm-key 와 항상 짝을 이뤄야 한다 — 그 키로 암호화된
// src-tauri/resources/ff_prot.wasm.enc 를 wasm_asset.rs 가 이 상수로 복호화한다. 서버 없는
// 구조라 키가 결국 앱 바이너리 안에 있어야 하므로, 이건 암호학적 안전성이 아니라 평문 .wasm
// 파일을 파일탐색기로 그냥 꺼내가는 것을 막는 수준의 방어다 (README/plan 참고).
pub const WASM_KEY: [u8; 32] = [${bytes.join(", ")}];
`;

fs.writeFileSync(outPath, rs);
console.log(`✓ ${outPath} 작성 완료`);
