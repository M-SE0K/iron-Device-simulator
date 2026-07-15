#!/usr/bin/env bash
# build-desktop.sh — 데스크톱용 독립 웹앱 정적 번들 빌드 (서버 없음)
#
# build:electron과 동일한 산출물(build-static-local.sh 공용 — 정적 export +
# 브라우저 WASM 엔진)을 그대로 쓴다. Electron 패키징 단계 없이 out/ 을 임의의 정적
# 파일 서버로 서빙하면, 데스크톱 브라우저에서도 브라우저 WASM 엔진만으로 동작한다.
set -euo pipefail
cd "$(dirname "$0")/.."

./scripts/build-static-local.sh

echo "✓ 데스크톱 독립 웹앱 빌드 완료: out/"
echo "  로컬 확인: npx serve out"
