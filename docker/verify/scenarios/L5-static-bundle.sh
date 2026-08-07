#!/usr/bin/env bash
# L5 — 정적 번들 + 타입/린트.
#
# build:desktop 은 Tauri 패키징(build:tauri*)의 첫 단계이기도 하다. 여기서 깨지면
# L6/L7 은 볼 것도 없으므로 먼저 세운다.
#
# 특히 build-desktop.sh 는 src/app/page.tsx 의 `export const dynamic` 을 빌드
# 동안만 "force-static" 으로 치환했다가 trap 으로 원복한다. 그 치환/원복이 깨지면
# 워킹 트리에 수정이 남거나(다음 빌드가 오염됨) 정적 export 자체가 실패한다.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
FIXTURES="$(cd "$(dirname "${BASH_SOURCE[0]}")/../fixtures" && pwd)"

echo "${C_BOLD}[L5] typecheck / lint / build:desktop${C_OFF}"

cd "$WORK" || { fail "스냅샷 경로 없음: $WORK"; finish; exit 1; }

[[ -d node_modules ]] || run_step "npm ci" npm ci
mkdir -p native/wasm-engine/custom
cp "$FIXTURES/custom-algo/dummy_algo.c" native/wasm-engine/custom/

section "1. 정적 검사"
run_step "npm run typecheck" npm run typecheck
run_step "npm run lint" npm run lint

section "2. 정적 번들 빌드"
# 치환 대상 파일의 원본을 기억해두고, 빌드 후 원복됐는지 확인한다.
PAGE_BEFORE="$(cat src/app/page.tsx)"
run_step "npm run build:desktop" npm run build:desktop

section "3. 산출물"
check_file out/index.html          "out/index.html (정적 export)"
check_file out/wasm/ff_prot.js     "out/wasm/ff_prot.js (글루)"
check_file out/wasm/ff_prot.wasm   "out/wasm/ff_prot.wasm (평문 — 웹 번들에는 남는 게 정상)"

section "4. 빌드가 워킹 트리를 오염시키지 않았는가"
if [[ "$PAGE_BEFORE" == "$(cat src/app/page.tsx)" ]]; then
  pass "src/app/page.tsx 원복됨 (force-static 치환 → trap 복원)"
else
  fail "src/app/page.tsx 가 원복되지 않았다 — 빌드가 소스를 수정한 채로 끝났다"
  info "build-desktop.sh 의 trap 'mv \$PAGE.bak \$PAGE' EXIT 확인"
fi
if [[ -f src/app/page.tsx.bak ]]; then
  fail "src/app/page.tsx.bak 잔재가 남았다"
else
  pass "백업 잔재 없음"
fi

# 하드닝은 normal 모드에서 기본 ON 이다 — 배포 번들에 난독화가 실제로 적용됐는지 확인.
if grep -qE '_0x[0-9a-f]{4,}' out/wasm/ff_prot.js 2>/dev/null; then
  pass "배포 번들의 글루 JS 가 난독화됨 (FF_PROT_HARDEN 기본 ON)"
else
  fail "배포 번들의 글루 JS 에 난독화 흔적이 없다 — build-desktop.sh 의 FF_PROT_HARDEN 기본값 확인"
fi

finish
