#!/usr/bin/env bash
# build-electron.sh — 데스크톱 Electron 앱 패키징 (macOS/Windows/Linux, 팀 내부 배포용)
#
# build-static-local.sh(공용 코어)로 만든 out/(브라우저 WASM 엔진, 서버리스)을
# electron/main.js와 함께 electron-builder로 패키징한다. 마켓 배포가 아니므로
# 코드 서명 없음 — macOS는 최초 실행 시 우클릭 → 열기, Windows는 SmartScreen에서
# "추가 정보 → 실행"이 한 번 필요하다.
set -euo pipefail
cd "$(dirname "$0")/.."

./scripts/build-static-local.sh

echo "▶ Electron 패키징 (mac/win/linux)..."
npx electron-builder --mac --win --linux

echo "✓ Electron 패키징 완료: dist-electron/"
