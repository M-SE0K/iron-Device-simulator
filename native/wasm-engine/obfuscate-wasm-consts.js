#!/usr/bin/env node
// obfuscate-wasm-consts.js — 컴파일된 .wasm "산출물"을 후처리해서 코드에 박힌 숫자
// 리터럴(f64/f32/i32/i64.const)을 mask+masked-value XOR 쌍으로 바꿔치기한다.
//
//   node obfuscate-wasm-consts.js <in-out.wasm>
//
// C 소스(custom/*.c)는 **전혀 건드리지 않는다** — 이 소스의 소유권이 없는 사용자가
// 자기 알고리즘을 custom/에 드롭인해도, 컴파일이 끝난 뒤 산출물(.wasm)만 보고 그
// 안에 박힌 숫자 상수를 알고리즘 내용을 몰라도 자동으로 찾아 흩뿌린다(어떤 상수가
// "의미 있는" 값인지 몰라도 됨).
//
// 방법: wasm2wat로 텍스트화 → 각 const 리터럴을
//   실수(f64/f32):  iN.const <mask> / iN.const <masked> / iN.xor / fN.reinterpret_iN
//   정수(i32/i64):  iN.const <mask> / iN.const <masked> / iN.xor
// (masked = bits(value) XOR mask, 빌드마다 새 난수)로 치환 → wat2wasm으로 재조립해
// 원본 .wasm을 덮어쓴다.
//
// ── 정수 상수 취급(2026 확장, 옛 Tigress EncodeArithmetic 대체) ─────────────────────
// 정수 리터럴은 실수보다 압도적으로 많고(메모리 오프셋·루프 카운터·인덱스 등), 전부
// 치환하면 바이너리가 크게 붓고 느려진다. 그래서 정수만 두 가지로 제한한다:
//   1) **함수 본문 코드에 한함** — wasm2wat flat 출력에서 함수 본문 명령은 "그 줄의 첫
//      토큰이 곧 니모닉"이다. 반면 global 초기화식·data/elem 오프셋식은 줄이 `(global`/
//      `(data`/`(elem` 로 시작한다. XOR/reinterpret는 **상수식(const expr)에선 불법**이라
//      그런 곳에 넣으면 모듈이 깨진다 — 줄 시작(^[ \t]*니모닉) 앵커가 자연히 걸러낸다.
//   2) **임계치 + 샘플링** — 절댓값이 FF_PROT_OBF_INT_MIN(기본 8) 미만인 사소한 값(0/1/2류
//      오프셋·인덱스)은 건너뛰고, 나머지도 FF_PROT_OBF_INT_RATE(기본 0.5) 확률로만 치환한다.
// 환경변수로 조정: FF_PROT_OBF_INT=off 로 정수 치환 전체 비활성(실수만), FF_PROT_OBF_INT_MIN,
// FF_PROT_OBF_INT_RATE. 실수(f64/f32)는 늘 전부 치환한다(옛 동작 보존).
//
// 이 스크립트는 build-wasm.sh의 마지막 WASM 가공 단계(wasm-opt·wasm-mutate 이후)에서만
// 불러야 한다 — 이후 어떤 최적화 패스도 돌지 않아야 XOR 패턴이 상수 폴딩으로 원복되지 않는다.
//
// wasm2wat/wat2wasm(wabt)만 쓰고 리터럴을 직접 파싱하지 않는다 — 대신 각 리터럴 토큰을
// "그 값 하나만 export하는" 미니 WAT 모듈로 감싸 wat2wasm+Node의 WebAssembly로 실제
// 실행해 정확한 비트를 얻는다(정수 부호/진법·IEEE754 반올림을 손으로 파싱하다 버그 내는
// 위험을 없앤다).
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

// ── 정수 치환 정책(환경변수) ────────────────────────────────────────────────
const INT_ENABLED = (process.env.FF_PROT_OBF_INT || "on").toLowerCase() !== "off";
const INT_MIN = BigInt(process.env.FF_PROT_OBF_INT_MIN ?? "8"); // |signed value| < INT_MIN 이면 건너뜀
const INT_RATE = Number(process.env.FF_PROT_OBF_INT_RATE ?? "0.5"); // 남은 정수 중 치환 비율

function wabt(bin, args) {
  return execFileSync("npx", ["--yes", "-p", "wabt", bin, ...args], { encoding: "utf8" });
}

const KIND_INFO = {
  f64: { nBytes: 8, int: "i64", reinterpret: "f64.reinterpret_i64" },
  f32: { nBytes: 4, int: "i32", reinterpret: "f32.reinterpret_i32" },
  i64: { nBytes: 8, int: "i64", reinterpret: null },
  i32: { nBytes: 4, int: "i32", reinterpret: null },
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wasm-obf-"));
try {
  const watPath = path.join(tmpDir, "orig.wat");
  wabt("wasm2wat", [wasmPath, "--enable-all", "-o", watPath]);
  const wat = fs.readFileSync(watPath, "utf8");

  // const 리터럴 라인 매칭 — wasm2wat 기본(flat) 출력은 한 줄에 명령 하나이고, 함수 본문
  // 명령은 줄 시작(들여쓰기 후) 첫 토큰이 니모닉이다. global/data/elem 초기화식은 줄이
  // `(global`/`(data`/`(elem` 로 시작하므로 이 앵커에 걸리지 않는다(위 정수 취급 §1 참고).
  // 토큰은 `[^\s)]+` — `\S+`로 잡으면 안 된다. wasm2wat는 함수/블록을 닫는 괄호를 본문
  // **마지막 명령 줄에 붙여서** 내기 때문에(`i32.const 0)`, 중첩이면 `i32.const 0)))`),
  // `\S+`는 그 괄호까지 토큰으로 먹어 probe 모듈을 조기에 닫아버린다. 줄의 나머지(닫는
  // 괄호·`(;=...;)` 주석)는 네 번째 그룹으로 따로 보존했다가 치환 후 되붙인다.
  const CONST_RE = /^([ \t]*)(f64|f32|i64|i32)\.const[ \t]+([^\s)]+)(.*)$/gm;
  const matches = [...wat.matchAll(CONST_RE)];
  if (matches.length === 0) {
    console.log("obfuscate-wasm-consts: const 리터럴 없음 — 변경 없이 종료");
    return;
  }

  // 값 추출용 미니 모듈 — 토큰마다(중복 제거) export 하나씩. 토큰을 직접 파싱하지 않고
  // wat2wasm+실제 실행으로 정확한 비트를 얻는다. i64는 BigInt로, i32는 32비트 Number로 반환된다.
  const uniqueTokens = [...new Set(matches.map((m) => `${m[2]}:${m[3]}`))];
  const probeFns = uniqueTokens.map((key, i) => {
    const sep = key.indexOf(":");
    const kind = key.slice(0, sep);
    const token = key.slice(sep + 1);
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
  const tokenBits = new Map(); // key -> BigInt(unsigned bits, nBytes 폭)
  uniqueTokens.forEach((key, i) => {
    const kind = key.slice(0, key.indexOf(":"));
    const { nBytes } = KIND_INFO[kind];
    const value = probeInstance.exports[`c${i}`]();
    let bits;
    if (kind === "f64") {
      const buf = Buffer.alloc(8); buf.writeDoubleLE(value); bits = buf.readBigUInt64LE();
    } else if (kind === "f32") {
      const buf = Buffer.alloc(4); buf.writeFloatLE(value); bits = BigInt(buf.readUInt32LE());
    } else if (kind === "i32") {
      bits = BigInt(value >>> 0); // Number(부호) → 32비트 무부호
    } else { // i64: WebAssembly가 BigInt로 반환(음수 가능) → 무부호로 정규화
      bits = value & ((1n << 64n) - 1n);
    }
    tokenBits.set(key, bits & ((1n << BigInt(nBytes * 8)) - 1n));
  });

  // 무부호 비트 → 부호 있는 절댓값(임계치 판정용)
  function signedMagnitude(bits, nBytes) {
    const width = BigInt(nBytes * 8);
    const signBit = 1n << (width - 1n);
    const signed = bits & signBit ? bits - (1n << width) : bits;
    return signed < 0n ? -signed : signed;
  }

  function randomBits(nBytes) {
    return nBytes === 8 ? crypto.randomBytes(8).readBigUInt64LE() : BigInt(crypto.randomBytes(4).readUInt32LE());
  }
  function hex(bits, nBytes) {
    return `0x${bits.toString(16).padStart(nBytes * 2, "0")}`;
  }

  let floatPatched = 0;
  let intPatched = 0;
  let intSkipped = 0;
  const out = wat.replace(CONST_RE, (line, indent, kind, token, trailing) => {
    const key = `${kind}:${token}`;
    const bits = tokenBits.get(key);
    if (bits === undefined) return line; // 이론상 없음(모든 토큰을 위에서 probe함)

    const { nBytes, int: intType, reinterpret } = KIND_INFO[kind];
    const isFloat = kind === "f64" || kind === "f32";

    // 정수: 비활성 / 사소한 값 / 샘플 탈락이면 원본 유지(위 §2)
    if (!isFloat) {
      if (!INT_ENABLED || signedMagnitude(bits, nBytes) < INT_MIN) { intSkipped++; return line; }
      // 결정성 불필요(빌드타임) — crypto 난수로 샘플링
      if (crypto.randomBytes(4).readUInt32LE() / 0xffffffff >= INT_RATE) { intSkipped++; return line; }
    }

    const mask = randomBits(nBytes);
    const maxU = (1n << BigInt(nBytes * 8)) - 1n;
    const masked = (bits ^ mask) & maxU;

    if (isFloat) floatPatched++; else intPatched++;
    const head =
      `${indent}${intType}.const ${hex(mask, nBytes)}\n` +
      `${indent}${intType}.const ${hex(masked, nBytes)}\n` +
      `${indent}${intType}.xor`;
    // 줄 나머지(닫는 괄호 등)는 반드시 **마지막** 명령 뒤에 되붙인다 — 앞에 두면
    // s-expression이 조기에 닫혀 모듈이 깨진다.
    return (reinterpret ? `${head}\n${indent}${reinterpret}` : head) + trailing;
  });

  const patchedWatPath = path.join(tmpDir, "patched.wat");
  fs.writeFileSync(patchedWatPath, out);
  wabt("wat2wasm", [patchedWatPath, "--enable-all", "-o", wasmPath]);

  console.log(
    `✓ obfuscate-wasm-consts: 실수 ${floatPatched}개 + 정수 ${intPatched}개 치환` +
    ` (정수 ${intSkipped}개는 임계치/샘플/비활성으로 건너뜀, 고유 토큰 ${uniqueTokens.length}개)`
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
