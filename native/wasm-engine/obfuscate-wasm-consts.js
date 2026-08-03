#!/usr/bin/env node
// obfuscate-wasm-consts.js — 컴파일된 .wasm "산출물"을 후처리해서 코드에 박힌 숫자
// 리터럴(f64.const/f32.const)을 mask+masked-value XOR 쌍으로 바꿔치기한다.
//
//   node obfuscate-wasm-consts.js <in-out.wasm>
//
// C 소스(custom/*.c)는 **전혀 건드리지 않는다** — 이 소스의 소유권이 없는 사용자가
// 자기 알고리즘을 custom/에 드롭인해도, 컴파일이 끝난 뒤 산출물(.wasm)만 보고 그
// 안에 박힌 숫자 상수를 알고리즘 내용을 몰라도 자동으로 찾아 흩뿌린다(어떤 상수가
// "의미 있는" 값인지 몰라도 됨 — f64.const/f32.const 전부를 대상으로 함).
//
// 방법: wasm2wat로 텍스트화 → f64.const/f32.const 리터럴을
//   i64.const <mask>
//   i64.const <masked>     (masked = bits(value) XOR mask, 빌드마다 새 난수)
//   i64.xor
//   f64.reinterpret_i64
// 4개 명령으로 치환(f32는 i32 계열) → wat2wasm으로 재조립해 원본 .wasm을 덮어쓴다.
// 이 스크립트는 build-wasm.sh의 마지막 WASM 가공 단계(wasm-opt 이후)에서만 불러야
// 한다 — 이후 어떤 최적화 패스도 돌지 않아야 XOR 패턴이 상수 폴딩으로 원복되지 않는다.
//
// wasm2wat/wat2wasm(wabt)만 쓰고 hex-float 리터럴을 직접 파싱하지 않는다 — 대신
// 각 리터럴 토큰을 "그 값 하나만 export하는" 미니 WAT 모듈로 감싸 wat2wasm+Node의
// WebAssembly로 실제 실행해 정확한 IEEE754 비트를 얻는다(hex-float 파서를 직접
// 구현하면서 반올림 버그를 낼 위험을 없앤다).
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const wasmPath = process.argv[2];
if (!wasmPath) {
  console.error("usage: obfuscate-wasm-consts.js <in-out.wasm>");
  process.exit(1);
}

function wabt(bin, args) {
  return execFileSync("npx", ["--yes", "-p", "wabt", bin, ...args], { encoding: "utf8" });
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wasm-obf-"));
try {
  const watPath = path.join(tmpDir, "orig.wat");
  wabt("wasm2wat", [wasmPath, "--enable-all", "-o", watPath]);
  const wat = fs.readFileSync(watPath, "utf8");

  // f64.const/f32.const 리터럴 라인 매칭 — wasm2wat 기본(flat) 출력은 한 줄에 명령 하나.
  const CONST_RE = /^([ \t]*)(f64|f32)\.const[ \t]+(\S+).*$/gm;
  const matches = [...wat.matchAll(CONST_RE)];
  if (matches.length === 0) {
    console.log("obfuscate-wasm-consts: f64.const/f32.const 없음 — 변경 없이 종료");
    return;
  }

  // 값 추출용 미니 모듈 — 토큰마다(중복 제거) export 하나씩. hex-float를 직접 파싱하지
  // 않고 wat2wasm+실제 실행으로 정확한 IEEE754 비트를 얻는다.
  const uniqueTokens = [...new Set(matches.map((m) => `${m[2]}:${m[3]}`))];
  const probeFns = uniqueTokens.map((key, i) => {
    const [kind, token] = key.split(":");
    return `(func (export "c${i}") (result ${kind}) ${kind}.const ${token})`;
  });
  const probeWat = `(module\n${probeFns.join("\n")}\n)\n`;
  const probeWatPath = path.join(tmpDir, "probe.wat");
  const probeWasmPath = path.join(tmpDir, "probe.wasm");
  fs.writeFileSync(probeWatPath, probeWat);
  wabt("wat2wasm", [probeWatPath, "--enable-all", "-o", probeWasmPath]);

  const probeBytes = fs.readFileSync(probeWasmPath);
  const probeModule = new WebAssembly.Module(probeBytes);
  const probeInstance = new WebAssembly.Instance(probeModule);
  const tokenBits = new Map(); // "f64:0x1.77p+15" -> BigInt(bits) (64-bit, f32는 32-bit로 zero-extend)
  uniqueTokens.forEach((key, i) => {
    const [kind] = key.split(":");
    const value = probeInstance.exports[`c${i}`]();
    const buf = Buffer.alloc(8);
    if (kind === "f64") {
      buf.writeDoubleLE(value);
      tokenBits.set(key, buf.readBigUInt64LE());
    } else {
      buf.writeFloatLE(value);
      tokenBits.set(key, BigInt(buf.readUInt32LE()));
    }
  });

  function randomBits(nBytes) {
    return nBytes === 8 ? crypto.randomBytes(8).readBigUInt64LE() : BigInt(crypto.randomBytes(4).readUInt32LE());
  }
  function hex(bits, nBytes) {
    const width = nBytes * 2;
    return `0x${bits.toString(16).padStart(width, "0")}`;
  }

  let patched = 0;
  const out = wat.replace(CONST_RE, (line, indent, kind, token) => {
    const key = `${kind}:${token}`;
    const bits = tokenBits.get(key);
    if (bits === undefined) return line; // 이론상 없음(모든 토큰을 위에서 probe함)

    const nBytes = kind === "f64" ? 8 : 4;
    const mask = randomBits(nBytes);
    const maxU = (1n << BigInt(nBytes * 8)) - 1n;
    const masked = (bits ^ mask) & maxU;

    const intType = kind === "f64" ? "i64" : "i32";
    const reinterpret = kind === "f64" ? "f64.reinterpret_i64" : "f32.reinterpret_i32";
    patched++;
    return (
      `${indent}${intType}.const ${hex(mask, nBytes)}\n` +
      `${indent}${intType}.const ${hex(masked, nBytes)}\n` +
      `${indent}${intType}.xor\n` +
      `${indent}${reinterpret}`
    );
  });

  const patchedWatPath = path.join(tmpDir, "patched.wat");
  fs.writeFileSync(patchedWatPath, out);
  wabt("wat2wasm", [patchedWatPath, "--enable-all", "-o", wasmPath]);

  console.log(`✓ obfuscate-wasm-consts: 상수 리터럴 ${patched}개(고유 ${uniqueTokens.length}개) → XOR 조립으로 치환 완료`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
