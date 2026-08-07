#!/usr/bin/env bash
# L4 — 하드닝 빌드 체인 (FF_PROT_HARDEN=1).
#
# 배포 빌드(build:desktop / build:tauri*)는 이 플래그를 자동으로 켠다. 체인이 길고
# 외부 도구 의존이 많아서(Java/Closure → wasm-opt → wasm-tools → javascript-obfuscator)
# 한 칸만 빠져도 조용히 건너뛰거나 배포 시점에 터진다.
#
# 특히 중요한 것: 이 모든 변형을 거친 뒤에도 **export 심볼 4개가 살아 있어야** 한다.
# 하드닝이 심볼을 날리면 앱은 빌드가 끝난 뒤 런타임에 가서야 깨진다.
#
# FF_PROT_MUTATE_ITERS 는 검증용으로 낮춘다(기본 1000회는 수십 분). "경로가 도는가"만
# 보면 되고, 실제 배포 강도는 --full-mutate 로 따로 돌린다.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
FIXTURES="$(cd "$(dirname "${BASH_SOURCE[0]}")/../fixtures" && pwd)"

MUTATE_ITERS="${VERIFY_MUTATE_ITERS:-20}"

echo "${C_BOLD}[L4] FF_PROT_HARDEN=1 하드닝 체인 (mutate ${MUTATE_ITERS}회)${C_OFF}"

cd "$WORK" || { fail "스냅샷 경로 없음: $WORK"; finish; exit 1; }

section "1. 체인 구성요소 존재 확인"
# 없어도 "비파괴적으로 건너뛰는" 도구가 섞여 있어서, 부재를 눈으로 확인해두지 않으면
# 하드닝이 반쯤만 적용된 채 배포된다.
if command -v java >/dev/null 2>&1; then
  pass "java (--closure 1 글루 압축)"
else
  fail "java 없음 — 하드닝 빌드가 --closure 1 단계에서 실패한다"
fi
if command -v wasm-tools >/dev/null 2>&1; then
  pass "wasm-tools (구조 변형 wasm-mutate)"
else
  warn "wasm-tools 없음 — 구조 변형이 조용히 건너뛰어진다(빌드는 성공). 배포 강도가 낮아짐"
fi

section "2. 하드닝 빌드"
mkdir -p native/wasm-engine/custom
cp "$FIXTURES/custom-algo/dummy_algo.c" native/wasm-engine/custom/
[[ -d node_modules ]] || run_step "npm ci" npm ci

# 비교 기준으로 평문 빌드 크기를 먼저 잡아둔다. --dev: 여기선 하드닝 체인만 보면
# 되고 암호화 스테이징(Tauri 키 파일 생성)은 이 레이어의 관심사가 아니다.
npm run build:wasm -- --dev >/dev/null 2>&1 || true
PLAIN_JS_SIZE=0
[[ -f public/wasm/ff_prot.js ]] && PLAIN_JS_SIZE=$(stat -c%s public/wasm/ff_prot.js 2>/dev/null || echo 0)

if FF_PROT_HARDEN=1 FF_PROT_MUTATE_ITERS="$MUTATE_ITERS" npm run build:wasm -- --dev; then
  pass "하드닝 빌드 완주"
else
  fail "하드닝 빌드 실패 — 배포 빌드(build:desktop/build:tauri*)가 같은 경로에서 막힌다"
fi

section "3. 하드닝 후에도 계약이 유지되는가"
check_wasm_exports "$WORK/public/wasm/ff_prot.wasm"

# --rename-globals false 가 유지되어야 FfProtModule 전역이 살아남는다. 난독화 옵션이
# 바뀌어 이 이름이 리네임되면 로더가 모듈을 못 찾는다.
if grep -q 'FfProtModule' public/wasm/ff_prot.js 2>/dev/null; then
  pass "난독화 후에도 FfProtModule 전역 유지"
else
  fail "난독화가 FfProtModule 전역을 없앴다 — wasm-client.ts 의 loadFactory() 가 깨진다"
fi

section "4. 하드닝이 실제로 적용됐는가"
# 디버그 심볼(name section)이 남아 있으면 wasm-opt --strip-debug 가 안 돈 것이다.
# customSections 로 정확히 본다 — 바이너리에서 "name" 문자열을 grep 하면 함수 이름이나
# 데이터 세그먼트에 우연히 걸려 오탐이 난다.
if node -e '
  const fs = require("fs");
  const m = new WebAssembly.Module(fs.readFileSync("public/wasm/ff_prot.wasm"));
  const n = WebAssembly.Module.customSections(m, "name").length
          + WebAssembly.Module.customSections(m, "producers").length;
  process.exit(n === 0 ? 0 : 1);
' 2>/dev/null; then
  pass "WASM name/producers 섹션 제거됨 (wasm-opt --strip-* 적용)"
else
  fail "WASM 에 name/producers 섹션이 남아 있다 — 스트립 단계가 적용되지 않았다"
fi

HARD_JS_SIZE=$(stat -c%s public/wasm/ff_prot.js 2>/dev/null || echo 0)
info "글루 JS 크기: 평문 ${PLAIN_JS_SIZE}B → 하드닝 ${HARD_JS_SIZE}B"
# javascript-obfuscator 의 string-array/control-flow-flattening 는 뚜렷한 흔적을 남긴다.
if grep -qE '_0x[0-9a-f]{4,}' public/wasm/ff_prot.js 2>/dev/null; then
  pass "글루 JS 난독화 적용됨 (javascript-obfuscator 식별자 패턴)"
else
  fail "글루 JS 에 난독화 흔적이 없다 — javascript-obfuscator 단계가 건너뛰어졌다"
fi

finish
