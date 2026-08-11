#!/usr/bin/env bash
# scripts/build/build-desktop.sh — 정적 export + 브라우저 WASM 엔진 빌드 (공용 코어)
#
# 정적 번들을 만든다. 분석은 항상 브라우저(WebView) 안의 WASM 엔진이 직접 수행한다
# (engine/protocol/local-socket.ts). Tauri 패키징(build-tauri.sh)이 첫 단계로 호출하는
# 코어 빌드 로직 — 산출물(out/)을 Tauri 셸이 감싸 서빙한다.
#
# src/app/page.tsx 의 `export const dynamic = "force-dynamic"` 은 런타임 서버가 있는
# 일반 배포용(USE_QUEUE를 재빌드 없이 재정의하기 위함)이라 정적 export와 호환되지
# 않는다(Next.js가 segment config에 리터럴 문자열만 허용). 빌드 동안만 "force-static"
# 리터럴로 임시 치환했다가 끝나면 원복한다.
# MOBILE_BUILD=1 (next.config.ts → output:"export") 로 next build → out/
#
# SKIP_WASM_BUILD=1 이면 emcc 컴파일 자체를 건너뛰고, public/wasm/ 에 이미 놓아둔
# ff_prot.{js,wasm}를 그대로 쓴다 — 리포의 .c 소스가 아니라 직접 빌드/수정한 커스텀 WASM 산출물을 패키징에 쓸 때
# (예: custom/ 드롭인 대신 이미 컴파일된 바이너리를 갖고 있는 경우) 미리 그 파일들을 대상
# 디렉터리에 복사해두고 이 플래그로 실행한다. build-tauri.sh의 SKIP_WIN_HELPER_BUILD와
# 같은 패턴.
set -euo pipefail
cd "$(dirname "$0")/../.."

PAGE=src/app/page.tsx
cp "$PAGE" "$PAGE.bak"
trap 'mv "$PAGE.bak" "$PAGE"' EXIT

sed -i.tmp 's/^export const dynamic = .*/export const dynamic = "force-static";/' "$PAGE"
rm -f "$PAGE.tmp"

WASM_OUT_DIR="public/wasm"

# 소스 난독화/빌드 하드닝(FF_PROT_HARDEN, native/wasm-engine/build-wasm.sh)은 기본 ON.
export FF_PROT_HARDEN="${FF_PROT_HARDEN:-1}"

if [[ "${SKIP_WASM_BUILD:-}" == "1" ]]; then
  echo "▶ WASM 컴파일 건너뜀 (SKIP_WASM_BUILD=1) — $WASM_OUT_DIR/의 기존 ff_prot.{js,wasm}를 그대로 씁니다"
  if [[ ! -f "$WASM_OUT_DIR/ff_prot.js" || ! -f "$WASM_OUT_DIR/ff_prot.wasm" ]]; then
    echo "✗ $WASM_OUT_DIR/ff_prot.js 또는 ff_prot.wasm 이 없습니다 — 커스텀 산출물을 먼저 그 경로에 놓아두세요." >&2
    exit 1
  fi
else
  echo "▶ 브라우저 타깃 WASM 빌드... ($WASM_OUT_DIR/)"
  # --dev: 이 시점엔 out/ 이 아직 없어 암호화 스테이징의 평문 삭제 로직이 스킵된다
  # (build-wasm.sh 상단 주석 참고) — 여기선 컴파일만 하고, Tauri 패키징은
  # build-tauri.sh가 out/ 생성 이후 stage-encrypted-wasm.sh를 별도로 호출한다.
  npm run build:wasm -- --dev
fi
export NEXT_PUBLIC_WASM_DIR="/${WASM_OUT_DIR#public/}"

echo "▶ Next.js 정적 export 빌드 (out/)..."
MOBILE_BUILD=1 npx next build

echo "✓ 정적 번들 완료: out/ (브라우저 WASM 엔진)"
