#!/usr/bin/env bash
# L1 — 환경 세팅 스크립트 완주 (bare 이미지 전용).
#
# Node 도 emcc 도 Rust 도 없는 맨 우분투에서 scripts/setup/setup-wsl.sh 가 끝까지
# 도는지 본다. nvm 설치, emsdk git clone, apt 의존 설치 경로가 실제로 실행되므로
# **느리다** (emsdk 만 1~2GB, 회선에 따라 10~25분). 릴리스 직전 1회용이다.
#
# 이 레이어가 warm 이미지와 setup 스크립트 사이의 드리프트를 잡는 유일한 장치다 —
# Dockerfile.warm 이 손으로 맞춰둔 도구 목록이 낡아도, 여기가 초록이면 문서와
# 스크립트는 여전히 옳다.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
FIXTURES="$(cd "$(dirname "${BASH_SOURCE[0]}")/../fixtures" && pwd)"

echo "${C_BOLD}[L1] scripts/setup/setup-wsl.sh 완주 (맨 우분투)${C_OFF}"

cd "$WORK" || { fail "스냅샷 경로 없음: $WORK"; finish; exit 1; }

# ── 1a. 알고리즘 소스가 아직 없는 상태 ──────────────────────────────────────
# 알고리즘팀이 실제로 처음 맞닥뜨리는 순서다: 클론 → 환경 세팅 → (그 다음에)
# 자기 소스 드롭인. README 는 setup-*.sh 를 "전제조건(Node/emcc/빌드 도구)만
# 갖춘다"고 설명하므로, 이 시점에 성공으로 끝나야 한다.
section "1a. 소스 드롭인 전 — setup-wsl.sh"
info "emsdk 다운로드 때문에 오래 걸립니다 (10~25분)"
if bash scripts/setup/setup-wsl.sh; then
  pass "소스 없는 상태에서 setup-wsl.sh 완주"
else
  fail "소스 없는 상태에서 setup-wsl.sh 실패 — 클론 직후 첫 명령이 에러로 끝난다"
  info "setup-wsl.sh 5/5 단계가 'npm run build:wasm' 를 조건 없이 호출하는지 확인할 것"
  info "(bootstrap.sh 는 같은 상황에서 엔진 빌드를 건너뛰고 안내 후 정상 종료한다)"
fi

# 이후 단계에서 emcc 를 쓰려면 PATH 를 잡아줘야 한다. setup-wsl.sh 는 ~/.bashrc 에
# 라인을 추가하지만 지금 셸에는 반영되지 않는다.
if [[ -s "$HOME/emsdk/emsdk_env.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/emsdk/emsdk_env.sh" >/dev/null 2>&1 || true
fi
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi

section "1b. 설치 결과 확인"
if command -v node >/dev/null 2>&1; then
  pass "node 사용 가능: $(node -v)"
else
  fail "node 가 설치되지 않았다 — nvm 경로 확인 필요"
fi
if command -v emcc >/dev/null 2>&1; then
  pass "emcc 사용 가능: $(emcc --version 2>/dev/null | head -1)"
else
  fail "emcc 가 설치되지 않았다 — emsdk 경로 확인 필요"
fi
if command -v java >/dev/null 2>&1; then
  pass "java 사용 가능 (하드닝 빌드의 --closure 1 에 필요)"
else
  warn "java 없음 — 로컬 emcc 로 하드닝 빌드 시 --closure 1 단계에서 실패한다"
fi

# ── 2. 소스를 넣은 뒤 다시 ──────────────────────────────────────────────────
section "2. 더미 알고리즘 드롭인 후 — setup-wsl.sh 재실행"
mkdir -p native/wasm-engine/custom
cp "$FIXTURES/custom-algo/dummy_algo.c" native/wasm-engine/custom/
info "드롭인: native/wasm-engine/custom/dummy_algo.c"

if bash scripts/setup/setup-wsl.sh; then
  pass "소스가 있는 상태에서 setup-wsl.sh 완주 (WASM 빌드 포함)"
else
  fail "소스가 있는데도 setup-wsl.sh 실패"
fi

check_wasm_exports "$WORK/public/wasm/ff_prot.wasm"

finish
