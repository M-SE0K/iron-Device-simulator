#!/usr/bin/env bash
# build-mac.sh — CoreAudio HAL 헬퍼(mac.swift)를 arm64+x64 universal binary로 컴파일한다.
# electron-builder mac 타깃이 [x64, arm64] 둘 다이므로 아키텍처 분기 없이 하나의 바이너리로 번들링한다.
# macOS 호스트(swiftc 필요)에서만 실행 가능 — build-electron.sh에서 mac 타깃 빌드 전 호출된다.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p dist
swiftc -O -target arm64-apple-macos11 -framework CoreAudio -framework AudioToolbox \
  -o dist/audio-device-helper-arm64 mac.swift
swiftc -O -target x86_64-apple-macos11 -framework CoreAudio -framework AudioToolbox \
  -o dist/audio-device-helper-x64 mac.swift
lipo -create -output dist/audio-device-helper dist/audio-device-helper-arm64 dist/audio-device-helper-x64
rm dist/audio-device-helper-arm64 dist/audio-device-helper-x64
chmod +x dist/audio-device-helper

echo "✓ audio-device-helper (universal): electron/native/macos/audio-device-helper/dist/audio-device-helper"

# query-device: CoreAudio 장치 조회 진단 도구 — 앱에 번들되지 않는 개발용 CLI라 호스트 아키텍처로만 빌드한다.
cc -O2 -o dist/query-device query-device.c -framework CoreAudio -framework CoreFoundation
chmod +x dist/query-device

echo "✓ query-device (host arch, dev-only): electron/native/macos/audio-device-helper/dist/query-device"
