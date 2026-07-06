#!/usr/bin/env bash
# build-mobile.sh — 모바일(Capacitor iOS/Android) 정적 번들 빌드
#
# 실제 빌드(정적 export + 브라우저 WASM 엔진)는 build-static-local.sh 공용 스크립트가
# 수행한다. 이 스크립트는 그 산출물(out/)을 Capacitor 네이티브 프로젝트로 동기화하는
# 다음 단계만 안내한다.
set -euo pipefail
cd "$(dirname "$0")/.."

./scripts/build-static-local.sh

echo "✓ 모바일 정적 번들 완료: out/"
echo "  다음 단계: npm run cap:sync"
