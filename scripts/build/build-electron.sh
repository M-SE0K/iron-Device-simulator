#!/usr/bin/env bash
# build-electron.sh — 데스크톱 Electron 앱 패키징 (macOS/Windows/Linux, 팀 내부 배포용)
#
# build-static-local.sh(공용 코어)로 만든 out/(브라우저 WASM 엔진, 서버리스)을
# electron/main.js와 함께 electron-builder로 패키징한다. 마켓 배포가 아니므로
# 코드 서명 없음 — macOS는 최초 실행 시 우클릭 → 열기, Windows는 SmartScreen에서
# "추가 정보 → 실행"이 한 번 필요하다.
#
# 플랫폼별 산출물은 dist-electron/{mac, windows, linux}로 분리 저장된다.
#
#   --mac-only      macOS 타깃만 빌드하고 종료 (Darwin 필수) — 로컬 mac 반복 작업용,
#                   win/linux 패키징을 건너뛰어 빠르다. npm run build:electron:mac 이 호출.
#   --windows-only  Windows 타깃만 빌드하고 종료. npm run build:electron:windows 가 호출.
#   --linux-only    Linux 타깃만 빌드하고 종료. npm run build:electron:linux 가 호출.
set -euo pipefail
cd "$(dirname "$0")/../.."

MAC_ONLY=false
WINDOWS_ONLY=false
LINUX_ONLY=false
case "${1:-}" in
  --mac-only)
    MAC_ONLY=true
    if [[ "$(uname)" != "Darwin" ]]; then
      echo "✗ --mac-only 는 Darwin(macOS)에서만 가능합니다 (CoreAudio 헬퍼 컴파일에 swiftc 필요)." >&2
      exit 1
    fi
    ;;
  --windows-only)
    WINDOWS_ONLY=true
    ;;
  --linux-only)
    LINUX_ONLY=true
    ;;
esac

./scripts/build/build-static-local.sh

# Electron 메인 프로세스(main.js/preload.js + ipc/*.js)를 electron-dist/ 로 번들링한다
# (webpack.electron.config.js). electron-builder.yml의 files가 electron-dist/**/*만
# 포함하므로 패키징 전에 반드시 있어야 한다.
npm run build:electron:main

# CoreAudio HAL 헬퍼(mac 전용, swiftc 필요)를 mac 타깃 패키징 전에 컴파일해둔다.
# electron-builder.yml의 mac.extraResources가 이 산출물을 참조한다.
# --windows-only/--linux-only 에서는 mac을 아예 패키징하지 않으므로 건너뛴다.
if [[ "$(uname)" == "Darwin" && "$WINDOWS_ONLY" != "true" && "$LINUX_ONLY" != "true" ]]; then
  ./native/macos/audio-device-helper/build-mac.sh
fi

# ASIO 헬퍼(Windows 전용)를 win 타깃 패키징 전에 크로스 컴파일한다.
# electron-builder.yml의 win.extraResources가 이 산출물(dist/audio-device-helper.exe)을 참조한다.
#
# ⚠️ 이 단계는 일부러 **실패 시 패키징을 중단시킨다.** 예전에는 Windows에서 손으로 빌드해
# 커밋해둔 exe를 그대로 집어갔는데, 소스를 고치고 빌드를 잊으면 낡은 exe가 조용히 패키징되어
# "앱에서만 안 되는" 상태가 된다(실제로 겪었다 — capture 구현이 빠진 exe가 들어가 앱에서는
# not-implemented 에러로만 보였고, 원인을 찾는 데 한참 걸렸다). 조용히 넘어가느니 여기서 멈춘다.
#
# 툴체인/SDK가 없는 환경에서 커밋된 exe로 그냥 패키징만 하려면 SKIP_WIN_HELPER_BUILD=1.
if [[ "$MAC_ONLY" != "true" && "$LINUX_ONLY" != "true" ]]; then
  if [[ "${SKIP_WIN_HELPER_BUILD:-}" == "1" ]]; then
    echo "▶ ASIO 헬퍼 빌드 건너뜀 (SKIP_WIN_HELPER_BUILD=1) — dist/의 기존 exe를 그대로 씁니다"
    HELPER_EXE="native/windows/audio-device-helper/dist/audio-device-helper.exe"
    if [[ -f "$HELPER_EXE" ]]; then
      echo "    기존 exe 빌드 시각: $(date -r "$HELPER_EXE" '+%Y-%m-%d %H:%M:%S')"
    else
      echo "✗ 건너뛰려 했으나 $HELPER_EXE 가 없습니다 — 패키징이 실패합니다." >&2
      exit 1
    fi
  else
    ./native/windows/audio-device-helper/build-win.sh
  fi
fi

# 플랫폼별 산출물 저장 디렉터리 초기화
mkdir -p dist-electron/{mac,windows,linux}
rm -rf dist-electron/{mac,windows,linux}/* dist-electron/*-unpacked dist-electron/mac-arm64 dist-electron/linux-arm64-unpacked 2>/dev/null || true

echo "▶ Electron 패키징 시작 (플랫폼별 빌드)..."
echo ""

# ===== macOS 패키징 =====
# mac.extraResources(electron-builder.yml)가 audio-device-helper(swiftc 산출물, 위에서
# Darwin에서만 빌드됨)를 요구하므로, macOS 패키징 자체도 Darwin 호스트에서만 시도한다 —
# Windows/Linux에서 그대로 두면 여기서 즉시 실패해(set -e) 아래 win/linux 패키징까지 못 간다.
# --windows-only/--linux-only 에서는 아예 건너뛴다.
if [[ "$WINDOWS_ONLY" != "true" && "$LINUX_ONLY" != "true" ]]; then
  if [[ "$(uname)" == "Darwin" ]]; then
    echo "▶ macOS 패키징 중..."
    TEMP_MAC="dist-electron-mac-build"
    rm -rf "$TEMP_MAC"
    mkdir -p "$TEMP_MAC"

    # 출력 디렉토리를 임시 폴더로 설정해서 다른 빌드와 격리
    npx electron-builder --mac --publish=never -c.directories.output="$TEMP_MAC"

    # 생성된 파일을 mac/ 폴더로 이동
    find "$TEMP_MAC" -maxdepth 1 -type f \( -name "*.dmg" -o -name "*.zip" -o -name "*.yml" -o -name "*.blockmap" \) -exec mv {} dist-electron/mac/ \;
    find "$TEMP_MAC" -maxdepth 1 -type d -name "*.app" -exec mv {} dist-electron/mac/ \; 2>/dev/null || true
    rm -rf "$TEMP_MAC"
  else
    echo "▶ macOS 패키징 건너뜀 (Darwin 호스트에서만 가능 — CoreAudio 헬퍼 컴파일에 swiftc 필요)"
  fi
fi

if [[ "$MAC_ONLY" == "true" ]]; then
  echo ""
  echo "✓ Electron 패키징 완료 (mac 전용): dist-electron/mac/"
  ls -lh dist-electron/mac/ | grep -v "^total" | awk '{printf "    %-60s %8s\n", $9, $5}'
  exit 0
fi

# ===== Windows 패키징 =====
if [[ "$LINUX_ONLY" != "true" ]]; then
  echo "▶ Windows 패키징 중..."
  TEMP_WIN="dist-electron-win-build"
  rm -rf "$TEMP_WIN"
  mkdir -p "$TEMP_WIN"

  npx electron-builder --win --publish=never -c.directories.output="$TEMP_WIN"

  find "$TEMP_WIN" -maxdepth 1 -type f \( -name "*.zip" -o -name "*.yml" -o -name "*.blockmap" \) -exec mv {} dist-electron/windows/ \;
  rm -rf "$TEMP_WIN"
fi

if [[ "$WINDOWS_ONLY" == "true" ]]; then
  echo ""
  echo "✓ Electron 패키징 완료 (windows 전용): dist-electron/windows/"
  ls -lh dist-electron/windows/ | grep -v "^total" | awk '{printf "    %-60s %8s\n", $9, $5}'
  exit 0
fi

# ===== Linux 패키징 =====
echo "▶ Linux 패키징 중..."
TEMP_LINUX="dist-electron-linux-build"
rm -rf "$TEMP_LINUX"
mkdir -p "$TEMP_LINUX"

npx electron-builder --linux --publish=never -c.directories.output="$TEMP_LINUX"

find "$TEMP_LINUX" -maxdepth 1 -type f \( -name "*.AppImage" -o -name "*.yml" -o -name "*.blockmap" \) -exec mv {} dist-electron/linux/ \;
rm -rf "$TEMP_LINUX"

if [[ "$LINUX_ONLY" == "true" ]]; then
  echo ""
  echo "✓ Electron 패키징 완료 (linux 전용): dist-electron/linux/"
  ls -lh dist-electron/linux/ | grep -v "^total" | awk '{printf "    %-60s %8s\n", $9, $5}'
  exit 0
fi

# ===== 결과 출력 =====
echo ""
echo "✓ Electron 패키징 완료:"
echo ""

echo "  macOS 산출물 (dist-electron/mac/):"
if [[ -n "$(ls -A dist-electron/mac/ 2>/dev/null)" ]]; then
  ls -lh dist-electron/mac/ | grep -v "^total" | awk '{printf "    %-60s %8s\n", $9, $5}'
else
  echo "    (없음)"
fi
echo ""

echo "  Windows 산출물 (dist-electron/windows/):"
if [[ -n "$(ls -A dist-electron/windows/ 2>/dev/null)" ]]; then
  ls -lh dist-electron/windows/ | grep -v "^total" | awk '{printf "    %-60s %8s\n", $9, $5}'
else
  echo "    (없음)"
fi
echo ""

echo "  Linux 산출물 (dist-electron/linux/):"
if [[ -n "$(ls -A dist-electron/linux/ 2>/dev/null)" ]]; then
  ls -lh dist-electron/linux/ | grep -v "^total" | awk '{printf "    %-60s %8s\n", $9, $5}'
else
  echo "    (없음)"
fi
echo ""
