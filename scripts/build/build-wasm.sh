#!/usr/bin/env bash
# scripts/build/build-wasm.sh — npm run build:wasm 의 진입점. native/wasm-engine/build-wasm.sh
# (같은 이름의 다른 스크립트 — WASM 컴파일, 특정 데스크톱 셸에 종속되지 않는 순수 컴파일 스크립트)를 그대로 호출하고,
# --enc 플래그가 있으면 이어서 Tauri 전용 WASM 암호화 스테이징
# (scripts/build/wasm-encryption/stage-encrypted-wasm.sh)까지 수행한다.
#
#   npm run build:wasm              # 컴파일만 (기존 동작과 동일)
#   npm run build:wasm -- --enc     # 컴파일 + src-tauri/resources/ff_prot.wasm.enc 스테이징
#                                    # (예전 build:wasm:enc 를 대체)
#
# FF_PROT_HARDEN/WASM_OUT_DIR 등 native/wasm-engine/build-wasm.sh 가 읽는 환경변수는 그대로 전달된다
# (예: FF_PROT_HARDEN=1 npm run build:wasm -- --enc).
# 암호화 스테이징 자체는 Tauri 셸 전용 관심사라 native/wasm-engine/ 안에 두지 않고
# 여기 wrapper에서만 분기한다 — native/wasm-engine/build-wasm.sh는 계속 셸-무관 컴파일 전용으로 남는다.
set -euo pipefail
cd "$(dirname "$0")/../.."

ENC=false
for arg in "$@"; do
  case "$arg" in
    --enc) ENC=true ;;
    *)
      echo "✗ 알 수 없는 옵션: $arg (지원: --enc)" >&2
      exit 1
      ;;
  esac
done

(cd native/wasm-engine && ./build-wasm.sh)

if $ENC; then
  ./scripts/build/wasm-encryption/stage-encrypted-wasm.sh
fi
