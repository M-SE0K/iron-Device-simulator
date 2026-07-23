#!/usr/bin/env bash
# build-static-local.sh — 정적 export + 브라우저 WASM 엔진 빌드 (공용 코어)
#
# 정적 번들을 만든다. 분석은 항상 브라우저(WebView) 안의 WASM 엔진이 직접 수행한다
# (engine/protocol/local-socket.ts). 데스크톱 독립 웹앱(npm run build:desktop, package.json이
# 이 스크립트를 직접 호출)과 Electron 패키징(build-electron.sh)이 공유하는 코어 빌드 로직 —
# 산출물(out/)은 동일하며, 그 뒤에 Electron으로 감싸느냐 정적 호스팅으로 그대로 서빙하느냐만 다르다.
#
# src/app/page.tsx 의 `export const dynamic = "force-dynamic"` 은 런타임 서버가 있는
# 일반 배포용(USE_QUEUE를 재빌드 없이 재정의하기 위함)이라 정적 export와 호환되지
# 않는다(Next.js가 segment config에 리터럴 문자열만 허용). 빌드 동안만 "force-static"
# 리터럴로 임시 치환했다가 끝나면 원복한다.
# MOBILE_BUILD=1 (next.config.ts → output:"export") 로 next build → out/
#
# WASM_MODE=debug 면 ff_prot.c의 FF_PROT_DEBUG_VI 실험(debug) 빌드(V/I 값 printf 덤프 포함)를
# public/wasm-debug/ 에 만들고 NEXT_PUBLIC_WASM_DIR로 그쪽을 가리키게 한다 — 클린 빌드
# (public/wasm/, 기본값이자 프로덕션·측정 공용)와는 물리적으로 분리된 산출물이라 서로 덮어쓰지
# 않는다. 측정(E2E 지연) 시에는 항상 기본값(WASM_MODE 미설정)을 쓰고 실행 시 ?e2e=1 로 켠다.
set -euo pipefail
cd "$(dirname "$0")/../.."

PAGE=src/app/page.tsx
cp "$PAGE" "$PAGE.bak"
trap 'mv "$PAGE.bak" "$PAGE"' EXIT

sed -i.tmp 's/^export const dynamic = .*/export const dynamic = "force-static";/' "$PAGE"
rm -f "$PAGE.tmp"

WASM_MODE="${WASM_MODE:-normal}"
if [[ "$WASM_MODE" == "debug" ]]; then
  echo "▶ 브라우저 타깃 WASM 빌드... (실험/debug — V/I 값 printf 덤프 포함, public/wasm-debug/)"
  npm run wasm:build:debug
  export NEXT_PUBLIC_WASM_DIR="/wasm-debug"
else
  echo "▶ 브라우저 타깃 WASM 빌드... (클린, public/wasm/)"
  npm run wasm:build
  export NEXT_PUBLIC_WASM_DIR="/wasm"
fi

echo "▶ Next.js 정적 export 빌드 (out/)..."
MOBILE_BUILD=1 npx next build

echo "✓ 정적 번들 완료: out/ (브라우저 WASM 엔진, WASM_MODE=$WASM_MODE)"
