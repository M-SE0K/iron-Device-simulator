#!/usr/bin/env bash
# L6 — Tauri Linux 패키징.
#
# Linux 타깃에는 네이티브 오디오 헬퍼가 없어서 앱으로서는 반쪽이지만, **Rust 셸이
# 컴파일되고 번들이 만들어지는가**를 확인하는 데는 충분하다. 그리고 무엇보다
# stage-encrypted-wasm.sh(WASM 암호화 스테이징)가 여기서 처음 실행된다 — 신규 클론에
# 없는 .wasm-seed 와 src-tauri/src/wasm_key.rs 를 만들어내는 경로다. 이게 깨지면
# cargo build 가 "wasm_key.rs 없음"으로 실패하는데, 로컬에는 이미 그 파일이 있어서
# 절대 재현되지 않는다.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
FIXTURES="$(cd "$(dirname "${BASH_SOURCE[0]}")/../fixtures" && pwd)"

echo "${C_BOLD}[L6] npm run build:tauri -- --linux${C_OFF}"

cd "$WORK" || { fail "스냅샷 경로 없음: $WORK"; finish; exit 1; }

section "1. 전제"
if command -v cargo >/dev/null 2>&1; then
  pass "cargo: $(cargo --version)"
else
  fail "cargo 없음 — Tauri 빌드 불가"
  finish; exit 1
fi
if pkg-config --exists webkit2gtk-4.1; then
  pass "webkit2gtk-4.1 개발 패키지 존재"
else
  fail "webkit2gtk-4.1 없음 — Tauri v2 Linux 빌드가 링크 단계에서 실패한다"
fi

# 신규 클론에는 없어야 정상인 것들. 빌드가 이걸 스스로 만들어내는지가 이 레이어의 핵심.
section "2. 빌드 전 상태 (신규 클론과 동일해야 함)"
check_absent native/wasm-engine/.wasm-seed "빌드가 생성해야 하는 키 재료"
check_absent src-tauri/src/wasm_key.rs     "빌드가 생성해야 하는 키 파생 소스"

[[ -d node_modules ]] || run_step "npm ci" npm ci
mkdir -p native/wasm-engine/custom
cp "$FIXTURES/custom-algo/dummy_algo.c" native/wasm-engine/custom/

section "3. 패키징"
info "첫 실행은 cargo 의존성 컴파일로 10~20분 걸립니다 (CARGO_TARGET_DIR 캐시 볼륨에 누적)"
run_step "npm run build:tauri -- --linux" npm run build:tauri -- --linux

section "4. 빌드가 생성해야 하는 파일"
check_file native/wasm-engine/.wasm-seed        ".wasm-seed 자동 생성 (머신당 1회)"
check_file src-tauri/src/wasm_key.rs            "wasm_key.rs 자동 생성 (없으면 cargo 실패)"
check_file src-tauri/resources/ff_prot.wasm.enc "암호화된 WASM 리소스"

section "5. 평문 WASM 이 번들에서 제거됐는가"
# Tauri 는 out/ 을 통째로 패키지에 넣는다. 평문 .wasm 이 남아 있으면 암호화가 무의미하다.
if [[ -f out/wasm/ff_prot.wasm ]]; then
  fail "out/wasm/ff_prot.wasm 평문이 남아 있다 — 패키지에 알고리즘이 그대로 실린다"
else
  pass "out/ 의 평문 WASM 제거됨 (글루 ff_prot.js 만 남음)"
fi
check_file out/wasm/ff_prot.js "out/wasm/ff_prot.js (글루는 평문으로 남는 게 정상)"

section "6. 번들 산출물"
shopt -s nullglob
BUNDLES=(dist-tauri/linux/*)
shopt -u nullglob
if [[ ${#BUNDLES[@]} -gt 0 ]]; then
  pass "dist-tauri/linux/ 산출물 ${#BUNDLES[@]}개"
  for b in "${BUNDLES[@]}"; do info "$(basename "$b") — $(du -h "$b" | cut -f1)"; done
else
  fail "dist-tauri/linux/ 가 비어 있다 — AppImage 번들링이 실패했을 수 있다"
  info "컨테이너에서 linuxdeploy 는 APPIMAGE_EXTRACT_AND_RUN=1 로 돈다(build-tauri.sh 가 설정)"
fi

finish
