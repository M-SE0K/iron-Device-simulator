#!/usr/bin/env bash
# L3 — 알고리즘 드롭인 → WASM 빌드.
#
# 이 리포에서 가장 값어치가 큰 레이어다. 벤더 알고리즘 소스는 우리 손에 없으므로,
# "계약(export 심볼 4개)만 만족하는 임의의 .c 를 custom/ 에 넣으면 빌드가 돈다"를
# 대신 확인한다. 알고리즘팀이 무엇을 넣든 파이프라인 쪽 책임은 여기서 갈린다.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
FIXTURES="$(cd "$(dirname "${BASH_SOURCE[0]}")/../fixtures" && pwd)"

echo "${C_BOLD}[L3] custom/ 드롭인 → npm run build:wasm${C_OFF}"

cd "$WORK" || { fail "스냅샷 경로 없음: $WORK"; finish; exit 1; }

section "1. 의존성"
if [[ -d node_modules ]]; then
  info "node_modules 재사용"
  pass "의존성 준비됨"
else
  # package-lock.json 기준 재현 설치. 알고리즘팀이 겪는 것과 같은 경로다.
  run_step "npm ci" npm ci
fi

section "2. 소스가 없을 때의 동작"
rm -f native/wasm-engine/custom/*.c native/wasm-engine/custom/*.h 2>/dev/null || true
# 컴파일할 소스가 하나도 없으면 build-wasm.sh 는 명확한 메시지와 함께 실패해야 한다.
# 조용히 성공하면(예: 빈 모듈 생성) 앱이 런타임에 가서야 깨진다.
expect_fail_step "소스 없이 build:wasm 는 명확히 실패해야 함" npm run build:wasm -- --dev

section "3. 더미 알고리즘 드롭인"
mkdir -p native/wasm-engine/custom
cp "$FIXTURES/custom-algo/dummy_algo.c" native/wasm-engine/custom/
info "드롭인: native/wasm-engine/custom/dummy_algo.c (헤더 include 없이 자립)"

run_step "npm run build:wasm -- --dev" npm run build:wasm -- --dev

section "4. 산출물 검증"
check_file public/wasm/ff_prot.js   "public/wasm/ff_prot.js (글루)"
check_file public/wasm/ff_prot.wasm "public/wasm/ff_prot.wasm"
check_wasm_exports "$WORK/public/wasm/ff_prot.wasm"

# 글루가 노출하는 전역 이름 — wasm-client.ts 의 loadFactory() 가 이 이름을 직접 읽는다.
if grep -q 'FfProtModule' public/wasm/ff_prot.js 2>/dev/null; then
  pass "글루 JS 가 FfProtModule 전역을 노출 (wasm-client.ts 계약)"
else
  fail "글루 JS 에 FfProtModule 이 없다 — 로더가 모듈을 못 찾는다"
fi

section "5. custom/ 우선순위"
# custom/ 에 소스가 있으면 상위 폴더의 참조 스텁은 빌드에서 빠져야 한다.
# 이게 깨지면 팀의 알고리즘과 스텁이 같이 링크되어 심볼 중복으로 터진다.
BUILD_LOG="$(mktemp)"
npm run build:wasm -- --dev > "$BUILD_LOG" 2>&1 || true
if grep -q 'custom/' "$BUILD_LOG"; then
  pass "빌드 대상이 custom/ 소스로 전환됨"
else
  warn "빌드 로그에서 custom/ 전환 메시지를 찾지 못함 (build-wasm.sh 의 소스 선택 로직 확인)"
fi
rm -f "$BUILD_LOG"

finish
