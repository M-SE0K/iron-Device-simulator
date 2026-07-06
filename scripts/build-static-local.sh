#!/usr/bin/env bash
# build-static-local.sh — 정적 export + 브라우저 WASM 엔진 빌드 (공용 코어)
#
# 정적 번들을 만든다. 분석은 항상 브라우저(WebView) 안의 WASM 엔진이 직접 수행한다
# (engine/protocol/local-socket.ts). Capacitor 모바일 패키징(build-mobile.sh)과
# 데스크톱 독립 웹앱(build-desktop.sh)이 공유하는 코어 빌드 로직 — 두 산출물은
# 동일하며(out/), 그 뒤에 Capacitor로 감싸느냐 정적 호스팅으로 그대로 서빙하느냐만
# 다르다.
#
# src/app/page.tsx 의 `export const dynamic = "force-dynamic"` 은 런타임 서버가 있는
# 일반 배포용(USE_QUEUE를 재빌드 없이 재정의하기 위함)이라 정적 export와 호환되지
# 않는다(Next.js가 segment config에 리터럴 문자열만 허용). 빌드 동안만 "force-static"
# 리터럴로 임시 치환했다가 끝나면 원복한다.
# MOBILE_BUILD=1 (next.config.ts → output:"export") 로 next build → out/
set -euo pipefail
cd "$(dirname "$0")/.."

PAGE=src/app/page.tsx
cp "$PAGE" "$PAGE.bak"
trap 'mv "$PAGE.bak" "$PAGE"' EXIT

sed -i.tmp 's/^export const dynamic = .*/export const dynamic = "force-static";/' "$PAGE"
rm -f "$PAGE.tmp"

echo "▶ 브라우저 타깃 WASM 빌드..."
npm run wasm:build

echo "▶ Next.js 정적 export 빌드 (out/)..."
MOBILE_BUILD=1 npx next build

echo "✓ 정적 번들 완료: out/ (브라우저 WASM 엔진으로 동작)"
