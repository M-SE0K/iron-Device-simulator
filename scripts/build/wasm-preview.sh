#!/usr/bin/env bash
# wasm-preview.sh — ff_prot.c(알고리즘)만 바꼈을 때 전체 재빌드 없이 Tauri로 빠르게 확인한다.
#
# Next.js의 output:"export"는 public/ 을 그대로 out/ 에 복사만 하므로, WASM 산출물만
# 다시 만들어서 out/ 안의 같은 파일을 덮어쓰면 next build 전체를 다시 돌리지 않아도 된다.
# Rust 쪽(src-tauri/)은 바뀌지 않았다고 가정한다 — IPC/창 생성 로직을 손봤다면 이 스크립트가
# 아니라 npm run tauri:preview를 써야 한다.
#
# WASM_MODE=debug|dummy 를 주면 wasm:build:debug/:dummy 와 같은 산출물(public/wasm-debug,
# public/wasm-dummy)을 만들어 out/의 같은 이름 폴더에 덮어쓴다 — 단, out/이 애초에 그 모드로
# 빌드되어 있어야 한다(NEXT_PUBLIC_WASM_DIR가 빌드 시점에 JS 번들에 박히기 때문에, 모드를
# 바꾸는 최초 1회는 build:tauri:mac:debug/:dummy 같은 전체 빌드가 필요).
#
# SKIP_WASM_BUILD=1 이면 emcc 컴파일 자체를 건너뛰고(build-static-local.sh와 동일한 플래그),
# public/$WASM_DIR_NAME/ 에 이미 놓아둔 ff_prot.{js,wasm}를 그대로 out/ 에 복사한다 — 다른
# 머신에서 빌드했거나 정품 소스로 직접 컴파일한 커스텀 WASM 산출물을 미리 그 경로에 넣어두고
# 쓸 때 쓴다. 리포의 .c 소스는 전혀 건드리지 않는다.
#
# `npx tauri dev`로 미리보기를 띄운다 — frontendDist(../out) 기준이라 전체 재빌드 없이
# out/만 갱신 후 확인하는 철학이 그대로 유지되고, 매 실행마다 Rust 쪽 변경분만 증분
# 재컴파일한다(Rust 소스를 안 건드렸으면 사실상 바로 뜬다).
set -euo pipefail
cd "$(dirname "$0")/../.."

WASM_MODE="${WASM_MODE:-normal}"
case "$WASM_MODE" in
  normal) WASM_DIR_NAME="wasm" ;;
  debug)  WASM_DIR_NAME="wasm-debug" ;;
  dummy)  WASM_DIR_NAME="wasm-dummy" ;;
  *) echo "알 수 없는 WASM_MODE: $WASM_MODE (normal|debug|dummy)" >&2; exit 1 ;;
esac

if [ ! -d out ]; then
  echo "out/ 이 없습니다 — 최초 1회는 npm run build:tauri:* 으로 만들어야 합니다." >&2
  exit 1
fi

OUT_WASM_DIR="out/$WASM_DIR_NAME"
if [ ! -d "$OUT_WASM_DIR" ]; then
  echo "$OUT_WASM_DIR 가 없습니다 — out/ 이 WASM_MODE=$WASM_MODE 로 빌드된 적이 없는 것 같습니다." >&2
  echo "최초 1회는 WASM_MODE=$WASM_MODE npm run build:tauri:mac 같은 전체 빌드가 필요합니다." >&2
  exit 1
fi

if [[ "${SKIP_WASM_BUILD:-}" == "1" ]]; then
  echo "▶ WASM 컴파일 건너뜀 (SKIP_WASM_BUILD=1) — public/$WASM_DIR_NAME/의 기존 ff_prot.{js,wasm}를 그대로 씁니다"
  if [ ! -f "public/$WASM_DIR_NAME/ff_prot.js" ] || [ ! -f "public/$WASM_DIR_NAME/ff_prot.wasm" ]; then
    echo "public/$WASM_DIR_NAME/ 에 ff_prot.js / ff_prot.wasm 가 없습니다 — 먼저 그 경로에 파일을 넣어두세요." >&2
    exit 1
  fi
else
  npm run "wasm:build$([ "$WASM_MODE" = normal ] && echo '' || echo ":$WASM_MODE")"
fi

cp "public/$WASM_DIR_NAME/ff_prot.js" "public/$WASM_DIR_NAME/ff_prot.wasm" "$OUT_WASM_DIR/"
echo "✓ $OUT_WASM_DIR 갱신 완료"

npx tauri dev
