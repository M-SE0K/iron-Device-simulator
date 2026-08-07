#!/usr/bin/env bash
# L7 — Windows 크로스 (ASIO 헬퍼 mingw + cargo-xwin 패키징).
#
# ⚠️ 이 레이어의 통과는 **실기 Windows 검증을 대체하지 않는다**. Tauri 자신이
#    cargo-xwin 경로를 실험적이라고 표시하고, 리포 README 도 실기 Windows 를
#    authoritative 로 못박고 있다. 여기서 잡는 것은 "크로스 경로가 여전히 도는가"와
#    "ASIO 헬퍼 소스가 컴파일되는가"까지다. 설치/실행/실제 ASIO 장치 동작은 못 본다.
#
# ASIO SDK 는 재배포 금지라 리포에도 이미지에도 없다. run.sh 의 --asio-sdk 로 호스트
# 경로를 마운트해야 이 레이어가 돌고, 없으면 SKIP 으로 보고한다(조용히 통과시키지 않는다).
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
FIXTURES="$(cd "$(dirname "${BASH_SOURCE[0]}")/../fixtures" && pwd)"

echo "${C_BOLD}[L7] Windows 크로스 — ASIO 헬퍼 + cargo-xwin 패키징${C_OFF}"

cd "$WORK" || { fail "스냅샷 경로 없음: $WORK"; finish; exit 1; }

# /asio-sdk 는 run.sh 가 --asio-sdk 로 마운트하는 read-only 경로.
ASIOSDK_DIR="${ASIOSDK_DIR:-/asio-sdk}"

section "1. 전제"
if [[ -f "$ASIOSDK_DIR/common/asio.h" ]]; then
  pass "ASIO SDK: $ASIOSDK_DIR"
else
  warn "ASIO SDK 없음 ($ASIOSDK_DIR) — L7 을 건너뜁니다"
  info "실행: npm run verify:docker -- --asio-sdk /path/to/ASIOSDK"
  info "SDK 는 Steinberg 배포본(common/ host/ 가 보이도록 압축 해제)을 쓰세요 — Teams 공유본"
  echo "SKIPPED" > /tmp/L7.status
  exit 0
fi
if command -v x86_64-w64-mingw32-g++ >/dev/null 2>&1; then
  pass "mingw-w64 크로스 컴파일러"
else
  fail "x86_64-w64-mingw32-g++ 없음 — ASIO 헬퍼를 컴파일할 수 없다"
fi
if command -v cargo-xwin >/dev/null 2>&1; then
  pass "cargo-xwin"
else
  fail "cargo-xwin 없음 — Windows 크로스 패키징 불가"
fi
if command -v makensis >/dev/null 2>&1; then
  pass "makensis (NSIS 인스톨러)"
else
  fail "makensis 없음 — NSIS 번들 생성 불가"
fi

section "2. ASIO 헬퍼 크로스 컴파일"
# build-tauri.sh 는 이 단계가 실패하면 패키징 전체를 세운다("낡은 exe 가 조용히
# 패키징되는 사고 방지"). 그 정책이 살아 있는지도 함께 보는 셈이다.
if ASIOSDK_DIR="$ASIOSDK_DIR" bash native/windows/audio-device-helper/build-win.sh; then
  pass "build-win.sh 완주"
else
  fail "ASIO 헬퍼 크로스 컴파일 실패 — build-tauri.sh 가 패키징 전체를 중단시킨다"
fi

HELPER="native/windows/audio-device-helper/dist/audio-device-helper.exe"
if [[ -f "$HELPER" ]]; then
  pass "헬퍼 exe 생성: $(du -h "$HELPER" | cut -f1)"
  # -static 으로 빌드되므로 PE 실행 파일이어야 한다.
  if file "$HELPER" | grep -q 'PE32+'; then
    pass "PE32+ 실행 파일 (x86-64)"
  else
    fail "산출물이 PE32+ 가 아니다: $(file "$HELPER")"
  fi
else
  fail "헬퍼 exe 가 생성되지 않았다"
fi

section "3. 헬퍼 단위 테스트"
# ring buffer / 샘플 변환은 호스트에서 그대로 컴파일해 돌릴 수 있다.
if [[ -f native/windows/audio-device-helper/tests/run-tests.sh ]]; then
  run_step "헬퍼 단위 테스트" bash native/windows/audio-device-helper/tests/run-tests.sh
else
  warn "헬퍼 단위 테스트 스크립트 없음 — 건너뜀"
fi

section "4. Windows 패키징 (cargo-xwin)"
[[ -d node_modules ]] || run_step "npm ci" npm ci
mkdir -p native/wasm-engine/custom
cp "$FIXTURES/custom-algo/dummy_algo.c" native/wasm-engine/custom/

info "첫 실행은 cargo-xwin 이 MS CRT/SDK 를 내려받습니다 (네트워크, 수 분 — XWIN_CACHE_DIR 볼륨에 누적)"
info "lld-link 의 'failed to load reference ...pdb' 경고 다수는 정상입니다 (xwin 이 전체 디버그 심볼을 받지 않음)"
run_step "npm run build:tauri -- --windows" env ASIOSDK_DIR="$ASIOSDK_DIR" npm run build:tauri -- --windows

section "5. 산출물"
shopt -s nullglob
EXES=(dist-tauri/windows/*.exe)
shopt -u nullglob
if [[ ${#EXES[@]} -gt 0 ]]; then
  pass "dist-tauri/windows/ 인스톨러 ${#EXES[@]}개"
  for e in "${EXES[@]}"; do info "$(basename "$e") — $(du -h "$e" | cut -f1)"; done
else
  fail "dist-tauri/windows/ 가 비어 있다"
fi

# 사이드카 파일명은 --target 트리플과 정확히 일치해야 한다. 크로스 경로에서 호스트
# 트리플(x86_64-unknown-linux-gnu)로 이름이 잡히는 버그가 실제로 있었다.
if [[ -f src-tauri/binaries/audio-device-helper-x86_64-pc-windows-msvc.exe ]]; then
  pass "사이드카 파일명이 크로스 타깃 트리플과 일치"
else
  fail "사이드카가 x86_64-pc-windows-msvc.exe 이름으로 배치되지 않았다 — externalBin 이 파일을 못 찾는다"
fi

echo
warn "이 레이어의 통과는 실기 Windows 검증을 대체하지 않는다 — 설치/실행/ASIO 장치 동작은 실기에서 확인할 것"

finish
