#!/usr/bin/env bash
# L0 — 클론 무결성.
#
# "git 에 올라간 것만으로 빌드에 착수할 수 있는가"를 본다. 도구를 하나도 안 쓰므로
# bare 이미지의 맨 처음(Node 설치 전)에도 돌아간다 — 그래서 여기서는 node/jq 를
# 쓰지 않고 grep/셸 내장만 쓴다.
#
# 이 레이어가 잡는 사고는 딱 하나다: **로컬에만 있는 파일에 빌드가 의존하는데
# 본인은 모르는 상태**. 개발 머신에서는 영원히 재현되지 않고, 클론한 사람에게만
# 터진다.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

echo "${C_BOLD}[L0] 클론 무결성 — tracked 파일만으로 빌드에 착수 가능한가${C_OFF}"
info "스냅샷: $WORK"

# ── 1. 빌드 진입점이 전부 있는가 ────────────────────────────────────────────
section "1. 필수 파일"
check_file package.json
check_file package-lock.json           "package-lock.json (npm ci 재현성)"
check_file tsconfig.json
check_file next.config.ts
check_file README.md
check_file README.ko.md
check_file scripts/setup/bootstrap.sh
check_file scripts/setup/setup-wsl.sh
check_file scripts/setup/setup-macos.sh
check_file scripts/build/build-desktop.sh
check_file scripts/build/build-tauri.sh
check_file scripts/build/build-wasm.sh
check_file scripts/build/wasm-encryption/stage-encrypted-wasm.sh
check_file scripts/build/wasm-encryption/derive-wasm-key.js
check_file scripts/build/wasm-encryption/encrypt-wasm.js
check_file scripts/build/wasm-encryption/gen-wasm-key-rs.js
check_file native/wasm-engine/build-wasm.sh
check_file native/wasm-engine/obfuscate-wasm-consts.js
check_file native/wasm-engine/custom/README.md   "custom/README.md (드롭인 계약 문서)"
check_file native/windows/audio-device-helper/build-win.sh
check_file native/macos/audio-device-helper/build-mac.sh
check_file src-tauri/tauri.conf.json
check_file src-tauri/Cargo.toml

# ── 2. 실행 비트 ────────────────────────────────────────────────────────────
# build-tauri.sh 등은 `./scripts/build/...` 형태로 직접 실행된다(bash 를 앞에 붙이지
# 않는다). 커밋 시 실행 비트가 빠지면 클론한 쪽에서 Permission denied 로만 보인다.
section "2. 실행 비트"
check_exec scripts/setup/bootstrap.sh
check_exec scripts/setup/setup-wsl.sh
check_exec scripts/setup/setup-macos.sh
check_exec scripts/build/build-desktop.sh
check_exec scripts/build/build-tauri.sh
check_exec scripts/build/build-wasm.sh
check_exec scripts/build/wasm-encryption/stage-encrypted-wasm.sh
check_exec native/wasm-engine/build-wasm.sh
check_exec native/windows/audio-device-helper/build-win.sh
check_exec native/macos/audio-device-helper/build-mac.sh

# ── 3. 들어가면 안 되는 것 ──────────────────────────────────────────────────
# 산출물이 섞여 들어가면 "빠진 파일" 버그를 가려버리고, 키 재료가 섞여 들어가면
# WASM 암호화(방법 5)가 통째로 무의미해진다.
section "3. 로컬 산출물/비밀 미포함"
check_absent node_modules                     "의존성은 npm ci 로 재생성되어야 한다"
check_absent out                              "정적 export 산출물 (build:desktop 으로 재생성)"
check_absent public/wasm                      "WASM 산출물 (build:wasm 로 재생성)"
check_absent dist-tauri                       "패키징 산출물"
check_absent src-tauri/target                 "cargo 빌드 캐시"
check_absent src-tauri/binaries               "사이드카 (빌드 시 배치)"
check_absent src-tauri/resources              "암호화 WASM 리소스 (빌드 시 생성)"
check_absent src-tauri/src/wasm_key.rs        "키 파생 소스 (빌드 시 생성)"
check_absent native/wasm-engine/.wasm-seed    "🔴 WASM 암호화 키 재료 — 커밋되면 암호화가 무의미해진다"
check_absent native/wasm-engine/.wasm-key     "🔴 WASM 암호화 키 — 커밋되면 암호화가 무의미해진다"
check_absent native/windows/audio-device-helper/dist  "ASIO 헬퍼 exe (매 패키징마다 재빌드)"
check_absent libirontune.so                   "벤더 바이너리 — 재배포 금지"

# macOS 헬퍼의 dist/ 는 (Windows 쪽과 달리) gitignore 대상이 아니라 실제로 커밋돼 있다.
# build-tauri.sh 는 mac 패키징 때 build-mac.sh 로 항상 새로 빌드하므로 이 커밋본은
# 쓰이지 않는다 — 즉 리포에 낡은 바이너리가 얹혀 다니는 상태다.
if [[ -e "$WORK/native/macos/audio-device-helper/dist" ]]; then
  warn "native/macos/audio-device-helper/dist/ 가 커밋돼 있다 — 패키징 때 재빌드되므로 쓰이지 않는 낡은 바이너리다(Windows 쪽은 gitignore)"
else
  pass "native/macos/audio-device-helper/dist 미포함"
fi

# ── 4. package.json 의 scripts 가 가리키는 파일이 실재하는가 ────────────────
# scripts 항목에 경로를 적어두고 정작 그 파일이 gitignore 되어 있는 조합이 가장
# 흔한 사고다. "npm run X" 를 치는 순간에만 드러난다.
section "4. npm scripts 참조 경로"
_missing_refs=0
while read -r ref; do
  [[ -z "$ref" ]] && continue
  if [[ -f "$WORK/$ref" ]]; then
    info "ok: $ref"
  else
    fail "package.json 의 scripts 가 참조하는 $ref 가 스냅샷에 없다"
    _missing_refs=$((_missing_refs + 1))
  fi
done < <(grep -oE '(\./)?(scripts|native)/[A-Za-z0-9가-힣_./-]+\.(sh|js|ts)' "$WORK/package.json" \
           | sed 's#^\./##' | sort -u)
[[ $_missing_refs -eq 0 ]] && pass "package.json scripts 가 참조하는 파일이 모두 존재"

# ── 5. 문서가 약속한 경로 ───────────────────────────────────────────────────
section "5. 문서-실물 정합"

# custom/ 드롭인 폴더는 README 가 "여기에 넣으세요"라고 지목하는 곳이다. 폴더 자체가
# tracked 되지 않으면(빈 디렉터리는 git 이 보존하지 않는다) 클론한 쪽에는 존재하지
# 않는다 — custom/README.md 가 그 역할을 겸한다.
if [[ -d "$WORK/native/wasm-engine/custom" ]]; then
  pass "native/wasm-engine/custom/ 존재 (드롭인 대상 폴더)"
else
  fail "native/wasm-engine/custom/ 이 없다 — README 가 지목하는 드롭인 폴더가 클론에 없다"
fi

# custom/README.md 의 래퍼 예시는 #include "ff_prot.h" 를 쓴다. 그런데 그 헤더는
# native/wasm-engine/.gitignore 로 제외된다 — 즉 예시를 그대로 따라 하면 컴파일이
# 깨진다. 로컬에는 헤더가 남아 있어 절대 재현되지 않는 종류의 문서 버그다.
_wants_header=0
grep -q 'ff_prot\.h' "$WORK/native/wasm-engine/custom/README.md" 2>/dev/null && _wants_header=1
if [[ $_wants_header -eq 1 && ! -f "$WORK/native/wasm-engine/ff_prot.h" ]]; then
  fail "custom/README.md 는 #include \"ff_prot.h\" 를 안내하지만 그 헤더가 클론에 없다 (.gitignore 제외) — 예시대로 따라 하면 컴파일 실패"
elif [[ $_wants_header -eq 1 ]]; then
  pass "custom/README.md 가 안내하는 ff_prot.h 가 클론에 존재"
else
  pass "custom/README.md 가 부재 헤더를 참조하지 않음"
fi

# ASIO SDK 는 재배포 금지라 리포에 없는 게 정상이다. README 가 그 사실과 배치 경로를
# 알려주는지 확인한다(모르면 Windows 패키징에서 처음 막힌다).
if grep -q 'ASIOSDK' "$WORK/README.md" 2>/dev/null; then
  pass "README.md 가 ASIO SDK 배치 경로를 안내"
else
  fail "README.md 에 ASIO SDK 안내가 없다 — Windows 패키징이 막힌 채로 이유를 알 수 없다"
fi

# README 가 링크하는 리포 내부 문서가 실제로 클론에 들어 있는가.
# 루트 .gitignore 가 /docs 를 통째로 제외하므로, README 에서 docs/ 를 안내하면
# 클론한 쪽에는 그 문서가 없다.
_dead_links=0
while read -r ref; do
  [[ -z "$ref" ]] && continue
  if [[ ! -e "$WORK/$ref" ]]; then
    fail "README.md 가 가리키는 $ref 가 클론에 없다 (문서가 gitignore 되어 있는지 확인)"
    _dead_links=$((_dead_links + 1))
  fi
done < <(grep -oE '(docs|native|scripts|src-tauri)/[A-Za-z0-9가-힣_./-]+\.(md|sh|json|c|h)' "$WORK/README.md" \
           | sort -u)
[[ $_dead_links -eq 0 ]] && pass "README.md 의 리포 내부 경로 참조가 모두 실재"

# ── 6. 알고리즘 소스는 없는 게 정상 ─────────────────────────────────────────
section "6. 알고리즘 소스 부재(정상 상태) 확인"
shopt -s nullglob
_algo=("$WORK"/native/wasm-engine/custom/*.c "$WORK"/native/wasm-engine/*.c)
shopt -u nullglob
if [[ ${#_algo[@]} -eq 0 ]]; then
  pass "엔진 .c 소스 없음 — 알고리즘팀이 클론했을 때와 동일한 상태"
else
  warn "엔진 .c 소스가 스냅샷에 있다(${#_algo[@]}개) — 알고리즘 소스를 커밋 중인지 확인할 것"
fi

finish
