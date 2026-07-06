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

# CoreAudio HAL 헬퍼(mac 전용, swiftc 필요)를 mac 타깃 패키징 전에 컴파일해둔다.
# electron-builder.yml의 mac.extraResources가 이 산출물을 참조한다.
if [[ "$(uname)" == "Darwin" ]]; then
  ./electron/native/audio-device-helper/build-mac.sh
fi

echo "▶ Electron 패키징 (mac/win/linux)..."
npx electron-builder --mac --win --linux

echo "✓ Electron 패키징 완료: dist-electron/"
