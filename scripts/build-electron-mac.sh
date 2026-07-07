#!/usr/bin/env bash
# build-electron-mac.sh — 데스크톱 Electron 앱 패키징 (macOS 전용, 팀 내부 배포용)
#
# build-electron.sh의 macOS 전용 변형. build-static-local.sh(공용 코어)로 만든
# out/(브라우저 WASM 엔진, 서버리스)을 electron/main.js와 함께 electron-builder로
# macOS 타깃(x64+arm64)만 패키징한다. 코드 서명 없음 — 최초 실행 시 우클릭 → 열기 필요.
#
# macOS 패키징은 CoreAudio HAL 헬퍼(swiftc 필요)를 함께 번들하므로 Darwin에서만 동작한다.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname)" != "Darwin" ]]; then
  echo "✗ macOS 패키징은 Darwin(macOS)에서만 가능합니다 (CoreAudio 헬퍼 컴파일에 swiftc 필요)." >&2
  exit 1
fi

./scripts/build-static-local.sh

# CoreAudio HAL 헬퍼(mac 전용, swiftc 필요)를 mac 타깃 패키징 전에 컴파일해둔다.
# electron-builder.yml의 mac.extraResources가 이 산출물을 참조한다.
./electron/native/audio-device-helper/build-mac.sh

echo "▶ Electron 패키징 (mac 전용)..."
npx electron-builder --mac

echo "✓ Electron 패키징 완료: dist-electron/"
