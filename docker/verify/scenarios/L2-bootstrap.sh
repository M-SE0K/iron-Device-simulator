#!/usr/bin/env bash
# L2 — 원커맨드 온보딩(bootstrap.sh).
#
# README 가 "클론 직후 이거 하나만 치세요"로 안내하는 경로다. 핵심 계약은
# **알고리즘 소스가 아직 없어도 실패하지 않고, 무엇을 어디에 넣어야 하는지 안내하고
# 정상 종료한다**는 것 — 이게 깨지면 알고리즘팀은 첫 명령부터 빨간 에러를 보고
# "리포가 고장났다"고 판단하게 된다.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
FIXTURES="$(cd "$(dirname "${BASH_SOURCE[0]}")/../fixtures" && pwd)"

echo "${C_BOLD}[L2] npm run bootstrap — 소스 없이도 안내 후 정상 종료${C_OFF}"

cd "$WORK" || { fail "스냅샷 경로 없음: $WORK"; finish; exit 1; }

# 이전 레이어가 남긴 드롭인 소스를 치워 "갓 클론한 상태"를 복원한다.
rm -f native/wasm-engine/custom/*.c native/wasm-engine/custom/*.h 2>/dev/null || true

section "1. 알고리즘 소스 없는 상태"
LOG="$(mktemp)"
if BOOTSTRAP_NO_DEV=1 bash scripts/setup/bootstrap.sh 2>&1 | tee "$LOG"; then
  pass "bootstrap 이 소스 없이도 exit 0 으로 종료"
else
  fail "bootstrap 이 소스 없는 상태에서 실패 — 클론 직후 첫 명령이 에러로 끝난다"
fi

if grep -q 'custom' "$LOG"; then
  pass "안내문이 드롭인 경로(custom/)를 알려줌"
else
  fail "안내문에 드롭인 경로가 없다 — 사용자가 다음에 뭘 해야 할지 모른다"
fi

if [[ -d node_modules ]]; then
  pass "npm install 완료 (node_modules 생성)"
else
  fail "node_modules 가 없다 — 의존성 설치가 건너뛰어졌다"
fi

if [[ -f public/wasm/ff_prot.wasm ]]; then
  fail "소스가 없는데 WASM 산출물이 생겼다 — 이전 실행 잔재이거나 스텁이 섞였다"
else
  pass "엔진 빌드는 건너뜀 (소스 없음 — 설계대로)"
fi
rm -f "$LOG"

section "2. 알고리즘 소스를 넣은 뒤"
mkdir -p native/wasm-engine/custom
cp "$FIXTURES/custom-algo/dummy_algo.c" native/wasm-engine/custom/
if BOOTSTRAP_NO_DEV=1 bash scripts/setup/bootstrap.sh; then
  pass "bootstrap 이 드롭인 소스로 엔진 빌드까지 완주"
else
  fail "드롭인 소스가 있는데 bootstrap 실패"
fi

check_wasm_exports "$WORK/public/wasm/ff_prot.wasm"

finish
