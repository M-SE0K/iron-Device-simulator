#!/usr/bin/env bash
# build-win.sh — ASIO 헬퍼를 mingw-w64로 **크로스 컴파일**한다 (Linux/WSL 호스트에서).
# macOS 쪽 build-mac.sh와 대칭이며, build-electron.sh가 Windows 타깃 패키징 직전에 호출한다.
#
# ⚠️ 왜 build.ps1(MSVC/CMake)이 아니라 이쪽이 정식 경로인가
#
# 패키징(build-electron.sh → electron-builder)이 WSL에서 돌기 때문이다. 여기서 MSVC를 쓰려면
# Windows로 소스를 옮겨 빌드하고 산출물을 되가져와야 하는데, 그 왕복을 사람이 손으로 하는 한
# **exe가 소스보다 낡은 채로 패키징되는 사고**가 반복된다(실제로 겪었다 — capture 구현이
# 통째로 빠진 exe가 zip에 들어갔고, 앱에서는 not-implemented 에러로만 보였다).
# 크로스 컴파일이면 패키징과 같은 호스트에서 같은 명령으로 끝나므로 그 틈이 사라진다.
#
# msvc/build.ps1 · msvc/CMakeLists.txt는 Windows에서 MSVC로 빌드해야 할 때를 위해 남겨둔 보조 경로다.
#
#   ./build-win.sh                      # ASIOSDK_DIR 또는 third_party/ASIOSDK 사용
#   ASIOSDK_DIR=/path/to/SDK ./build-win.sh
set -euo pipefail
cd "$(dirname "$0")"

CXX=x86_64-w64-mingw32-g++
SDK="${ASIOSDK_DIR:-$PWD/third_party/ASIOSDK}"

if ! command -v "$CXX" >/dev/null 2>&1; then
  echo "✗ $CXX 가 없습니다. mingw-w64 크로스 컴파일러를 설치하세요:" >&2
  echo "    sudo apt install g++-mingw-w64-x86-64" >&2
  exit 1
fi

# SDK는 재배포 금지라 리포에 없다 — 빌드하는 사람이 직접 배치하고 위치를 알려준다.
if [[ ! -f "$SDK/common/asio.h" ]]; then
  echo "✗ ASIO SDK를 찾지 못했습니다: $SDK" >&2
  echo "  Steinberg ASIO SDK 2.3을 common/ host/ 가 보이도록 풀고 다음 중 하나로 지정하세요:" >&2
  echo "    ASIOSDK_DIR=<경로> ./build-win.sh" >&2
  echo "    또는 $PWD/third_party/ASIOSDK 에 배치" >&2
  exit 1
fi

mkdir -p dist
OBJ=$(mktemp -d)
trap 'rm -rf "$OBJ"' EXIT

INCLUDES=(-Isrc -I"$SDK/common" -I"$SDK/host" -I"$SDK/host/pc")

# SDK는 라이브러리가 아니라 소스를 직접 컴파일해 넣는 구조다. driver/ 밑(asiodrvr, dllentry 등)은
# ASIO 드라이버를 *만들* 때 쓰는 것이라 호스트인 우리는 절대 포함하면 안 된다 —
# 넣으면 DllMain 등이 딸려와 링크가 깨진다.
#
# SDK 소스는 -w로 컴파일한다. 90년대 코드라 경고가 쏟아지는데, 그게 우리 코드의 경고를
# 가려버린다 (CMakeLists.txt가 MSVC에서 _CRT_SECURE_NO_WARNINGS를 주는 것과 같은 이유).
for src in "$SDK/common/asio.cpp" "$SDK/host/asiodrivers.cpp" "$SDK/host/pc/asiolist.cpp"; do
  "$CXX" -std=c++17 -O2 -w -c "$src" -o "$OBJ/$(basename "$src" .cpp).o" "${INCLUDES[@]}"
done

# 우리 코드는 경고를 다 켜고 본다. 소스는 src/ 아래에 있다.
for f in src/main.cpp src/asio_backend.cpp; do
  "$CXX" -std=c++17 -O2 -Wall -Wextra -c "$f" -o "$OBJ/$(basename "$f" .cpp).o" "${INCLUDES[@]}"
done

# -static: VC++/mingw 런타임 DLL 의존을 없앤다. electron-builder가 exe 하나만 리소스로
#          복사하므로 DLL에 의존하면 사용자 PC에서 실행이 실패한다.
"$CXX" -static -o dist/audio-device-helper.exe "$OBJ"/*.o \
  -lole32 -loleaut32 -luuid -luser32 -ladvapi32

echo "✓ audio-device-helper.exe (x64): electron/native/windows/audio-device-helper/dist/audio-device-helper.exe"
