#!/usr/bin/env bash
# build-mobile.sh — 모바일(Capacitor iOS/Android) 정적 번들 빌드
#
# 1) native/ff_prot.c 를 브라우저 타깃 WASM으로 빌드 (public/wasm/)
# 2) src/app/page.tsx 의 `export const dynamic = "force-dynamic"` 은 런타임 서버가
#    있는 일반/Docker 배포용(USE_QUEUE를 재빌드 없이 재정의하기 위함)이라 정적 export와
#    호환되지 않는다(Next.js가 segment config에 리터럴 문자열만 허용). 빌드 동안만
#    "force-static" 리터럴로 임시 치환했다가 끝나면 원복한다.
# 3) MOBILE_BUILD=1 (next.config.ts → output:"export") + NEXT_PUBLIC_LOCAL_ENGINE=true
#    (컴포넌트가 서버 WS 대신 브라우저 WASM을 쓰도록) 로 next build → out/
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
MOBILE_BUILD=1 NEXT_PUBLIC_LOCAL_ENGINE=true npx next build

echo "✓ 모바일 정적 번들 완료: out/"
