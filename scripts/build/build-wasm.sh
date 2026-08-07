#!/usr/bin/env bash
# scripts/build/build-wasm.sh — npm run build:wasm 의 진입점. native/wasm-engine/build-wasm.sh
# (같은 이름의 다른 스크립트 — WASM 컴파일, 특정 데스크톱 셸에 종속되지 않는 순수 컴파일 스크립트)를 그대로 호출하고,
# 기본적으로 이어서 Tauri 전용 WASM 암호화 스테이징
# (scripts/build/wasm-encryption/stage-encrypted-wasm.sh)까지 수행한다.
# --dev 플래그를 주면 암호화 스테이징을 건너뛰고 컴파일만 한다.
#
#   npm run build:wasm              # 컴파일 + src-tauri/resources/ff_prot.wasm.enc 스테이징 (기본값)
#   npm run build:wasm -- --dev     # 컴파일만 (암호화 스테이징 생략 — 일반 dev/setup/CI 용)
#
# FF_PROT_HARDEN/WASM_OUT_DIR 등 native/wasm-engine/build-wasm.sh 가 읽는 환경변수는 그대로 전달된다
# (예: FF_PROT_HARDEN=1 npm run build:wasm -- --dev).
# 암호화 스테이징 자체는 Tauri 셸 전용 관심사라 native/wasm-engine/ 안에 두지 않고
# 여기 wrapper에서만 분기한다 — native/wasm-engine/build-wasm.sh는 계속 셸-무관 컴파일 전용으로 남는다.
#
# ⚠ build:desktop(순수 정적 웹 번들, 브라우저 탭엔 복호화 키를 안전히 둘 곳이 없어 암호화 대상이
# 아님)은 out/ 이 만들어지기 전에 이 스크립트를 호출하므로 반드시 --dev 를 넘긴다 — 그렇지 않으면
# 이 시점엔 out/ 이 없어 평문 삭제 로직이 스킵되고, 뒤이은 next build 가 평문 .wasm 을 다시
# out/ 에 복사해 암호화 사이드이펙트(키 파일 생성)만 남긴 채 실질 효과가 없다.
set -euo pipefail
cd "$(dirname "$0")/../.."

ENC=true
for arg in "$@"; do
  case "$arg" in
    --dev) ENC=false ;;
    *)
      echo "✗ 알 수 없는 옵션: $arg (지원: --dev)" >&2
      exit 1
      ;;
  esac
done

(cd native/wasm-engine && ./build-wasm.sh)

if $ENC; then
  ./scripts/build/wasm-encryption/stage-encrypted-wasm.sh
fi
