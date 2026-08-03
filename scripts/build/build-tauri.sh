#!/usr/bin/env bash
# build-tauri.sh — 데스크톱 Tauri v2 앱 패키징 (유일한 데스크톱 셸)
#
# build-static-local.sh(공용 코어)로 만든 out/을 Tauri 번들러(tauri-bundler)로 패키징한다.
# 이 패키징 모델에는 electron-builder와 근본적으로 다른 제약이 하나 있다:
#
#   ⚠️ Tauri는 electron-builder와 달리 **호스트 OS = 타깃 OS**가 원칙이다. 이 스크립트는
#      "정직하게 되는 것만 만든다"는 원칙을 유지한다 — **이 스크립트는 실행당 최대 하나의
#      타깃만 만든다.**
#
#      단, Windows 타깃 하나만은 예외로 WSL/Linux 호스트에서도 cargo-xwin(+ NSIS)를 쓰는
#      **크로스 경로**를 제공한다 — 이는 Tauri가 공식 문서에 실험적(experimental)이라고
#      명시한 경로다. 편의 기능이니 실제 배포 전에는 반드시 실기 Windows에서 한 번 더
#      검증하는 것을 권장한다(아래 --windows-only 항목 참고).
#
# 그래서 옵션 없이 실행해도 electron-builder처럼 "전부 빌드"가 아니라 **호스트 OS에 맞는
# 타깃 하나를 자동 선택**해서 빌드한다 — 나머지는 애초에 이 머신에서 만들 수 없다.
#
#   --mac-only      macOS 타깃 (Darwin 호스트 필수 — swiftc로 CoreAudio 헬퍼 컴파일).
#                   npm run build:tauri:mac 이 호출.
#   --windows-only  Windows 타깃. Windows 호스트에서는 네이티브로 빌드한다. WSL/Linux
#                   호스트에서는 cargo-xwin + NSIS 크로스 경로로 자동 전환한다(실험적 —
#                   위 헤더 참고). macOS 호스트에서는 xwin 툴체인이 셋업되어 있지 않아
#                   지원하지 않고 에러로 안내한다. npm run build:tauri:windows 가 호출.
#   --linux-only    Linux 타깃 (Linux 호스트 필수). npm run build:tauri:linux 가 호출.
#
# tauri.conf.json은 타깃 OS에 맞는 tauri.<macos|windows>.conf.json을 CLI가 자동
# 병합한다(Tauri v2 Platform-Specific Configuration) — 이 스크립트가 --config를 넘길
# 필요는 없다. **실측 확인(2026-07)**: `--target x86_64-pc-windows-msvc`로 크로스
# 빌드할 때도 호스트가 Linux여도 CLI는 --target으로 지정한 타깃 OS 기준으로
# tauri.windows.conf.json을 정상 병합한다(externalBin 포함) — merge 기준이 "실행 중인
# OS"가 아니라 "빌드 타깃"이라는 뜻이다. 그래서 --config를 따로 넘길 필요가 없었다.
# Linux는 병합 파일이 없으므로 externalBin 없는 기본 conf 그대로 빌드된다 = 헬퍼 없음
# (Linux는 네이티브 오디오 헬퍼 자체가 아직 없다 — unsupported-platform).
set -euo pipefail
cd "$(dirname "$0")/../.."

# ── 호스트 OS 판별 ───────────────────────────────────────────────────────────
# Windows 네이티브에서 이 bash 스크립트를 돌리는 경로는 Git Bash/MSYS2를 가정한다
# (uname이 MINGW64_NT.../MSYS_NT... 형태로 나온다). PowerShell/cmd에서 직접 실행하는
# 경로는 지원 대상이 아니다(리포의 다른 빌드 스크립트도 전부 bash 전제).
HOST_UNAME="$(uname)"
case "$HOST_UNAME" in
  Darwin) HOST_OS=mac ;;
  Linux) HOST_OS=linux ;;
  MINGW* | MSYS* | CYGWIN*) HOST_OS=windows ;;
  *) HOST_OS=unknown ;;
esac

MAC_ONLY=false
WINDOWS_ONLY=false
LINUX_ONLY=false
WINDOWS_CROSS=false   # true면 WSL/Linux 호스트 + cargo-xwin 크로스 경로 (아래 --windows-only 참고)
case "${1:-}" in
  --mac-only)
    MAC_ONLY=true
    if [[ "$HOST_OS" != "mac" ]]; then
      echo "✗ --mac-only 는 macOS(Darwin) 호스트에서만 가능합니다 (CoreAudio 헬퍼 컴파일에 swiftc 필요 + Tauri 호스트 OS = 타깃 OS 원칙)." >&2
      exit 1
    fi
    ;;
  --windows-only)
    WINDOWS_ONLY=true
    case "$HOST_OS" in
      windows)
        : # 네이티브 경로 — 기존 그대로 아래에서 npx tauri build 실행
        ;;
      linux)
        # WSL/Linux 호스트 → cargo-xwin(+ NSIS) 크로스 경로로 전환한다. Tauri 공식 문서가
        # "experimental"로 명시한 경로다(위 헤더 주석 참고) — 편의 기능이며, 실제 배포
        # 전에는 실기 Windows에서 한 번 더 최종 검증하는 것을 권장한다.
        WINDOWS_CROSS=true
        echo "▶ WSL/Linux 호스트에서 --windows-only 감지 → cargo-xwin 크로스 경로로 전환합니다 (실험적)." >&2
        echo "  실제 배포 전에는 실기 Windows에서 한 번 더 검증하는 것을 권장합니다." >&2
        ;;
      *)
        echo "✗ --windows-only 는 Windows 호스트 또는 WSL/Linux(cargo-xwin 크로스, 실험적)에서만 가능합니다." >&2
        echo "  이 호스트($HOST_UNAME)는 둘 다 아닙니다 — macOS에는 xwin 크로스 툴체인이 셋업되어 있지" >&2
        echo "  않아 지원 대상에서 제외했습니다(docs/TAURI_MIGRATION_PLAN.md 7.4 참고)." >&2
        echo "  ASIO 헬퍼 exe만 미리 만들어두려면 native/windows/audio-device-helper/build-win.sh를" >&2
        echo "  직접 실행하고, 실제 tauri build(패키징)는 Windows 또는 WSL/Linux 머신에서" >&2
        echo "  SKIP_WIN_HELPER_BUILD=1 npm run build:tauri:windows 로 그 exe를 그대로 써서 실행하세요." >&2
        exit 1
        ;;
    esac
    ;;
  --linux-only)
    LINUX_ONLY=true
    if [[ "$HOST_OS" != "linux" ]]; then
      echo "✗ --linux-only 는 Linux 호스트에서만 가능합니다 (Tauri 호스트 OS = 타깃 OS 원칙)." >&2
      exit 1
    fi
    ;;
  "") ;;
  *)
    echo "✗ 알 수 없는 옵션: ${1}" >&2
    exit 1
    ;;
esac

# 옵션이 없으면 호스트 OS에 맞는 타깃 하나를 자동 선택한다 — electron-builder처럼 "전부"가
# 원천적으로 불가능하므로, 여기서 침묵하고 아무것도 안 만드는 대신 명시적으로 알린다.
if [[ "$MAC_ONLY" != "true" && "$WINDOWS_ONLY" != "true" && "$LINUX_ONLY" != "true" ]]; then
  case "$HOST_OS" in
    mac) MAC_ONLY=true ;;
    windows) WINDOWS_ONLY=true ;;
    linux) LINUX_ONLY=true ;;
    *)
      echo "✗ 인식할 수 없는 호스트 OS(uname: $HOST_UNAME) — --mac-only/--windows-only/--linux-only 중 하나를 명시하세요." >&2
      exit 1
      ;;
  esac
  echo "▶ 옵션 없음 → 호스트 OS 기준 자동 선택: $HOST_OS (Tauri는 크로스 패키징 불가 — 위 헤더 주석 참고)"
fi

./scripts/build/build-static-local.sh

# WASM 알고리즘 암호화 배포(방법 5) — out/의 평문 ff_prot.wasm을 지우고 암호화된 사본을
# src-tauri/resources/(bundle.resources, tauri.conf.json)로 옮긴다. mac/windows/linux 등
# 아래 OS별 분기보다 먼저, 한 번만 실행하면 모든 타깃에 적용된다.
./scripts/build/stage-encrypted-wasm.sh

# ===== 헬퍼 빌드 =====

# CoreAudio HAL 헬퍼(mac 전용, swiftc 필요)를 mac 패키징 전에 컴파일한다. build-mac.sh는
# arm64+x64 lipo universal 바이너리(native/macos/audio-device-helper/dist/audio-device-helper)를
# 만든다 — 이 universal 바이너리 하나를 아래에서 두 사이드카 트리플 이름으로 복사해 재사용한다.
if [[ "$MAC_ONLY" == "true" ]]; then
  ./native/macos/audio-device-helper/build-mac.sh
fi

# ASIO 헬퍼(Windows 전용) — "낡은 exe가 조용히 패키징되는 사고 방지" 원칙을 유지한다:
# 기본은 매번 새로 빌드하고, 실패 시 즉시 중단한다.
#
# build-win.sh는 mingw-w64 크로스 컴파일러 전제다(원래 WSL/Linux 호스트에서 exe를 만들어
# 크로스 패키징하는 흐름을 위해 작성됨) — WINDOWS_CROSS
# 경로(WSL/Linux 호스트)에서는 그대로 자연스럽게 맞아떨어진다. 네이티브 Windows 호스트에서
# 이 단계를 통과시키려면 그 머신에도 mingw-w64가 설치돼 있어야 한다. 실무 흐름은 다음 중 하나:
#   (a) Windows 머신에도 mingw-w64를 설치해두고 그대로 이 단계를 통과시키거나,
#   (b) exe는 WSL/Linux에서 build-win.sh로 미리 만들어 native/windows/audio-device-helper/dist/에
#       두고, Windows 머신에서는 SKIP_WIN_HELPER_BUILD=1 로 그 exe를 그대로 패키징한다.
if [[ "$WINDOWS_ONLY" == "true" ]]; then
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

# ===== 사이드카 배치: src-tauri/binaries/audio-device-helper-<타깃 트리플>[.exe] =====
# bundle.externalBin(tauri.macos.conf.json / tauri.windows.conf.json)에 선언된 사이드카는
# 선언된 모든 트리플 파일이 "존재"해야 번들이 성공한다(실제 아키텍처 일치 여부는 검사하지
# 않는다) — 계획서 5.9 참고. 이전 실행의 잔재가 남아 있으면 헷갈리므로 매번 비우고 시작한다.
mkdir -p src-tauri/binaries
rm -f src-tauri/binaries/audio-device-helper-* 2>/dev/null || true

if [[ "$MAC_ONLY" == "true" ]]; then
  HELPER_SRC="native/macos/audio-device-helper/dist/audio-device-helper"
  if [[ ! -f "$HELPER_SRC" ]]; then
    echo "✗ $HELPER_SRC 가 없습니다 (build-mac.sh 실패?)." >&2
    exit 1
  fi
  # lipo universal 바이너리 하나를 두 트리플 이름으로 복사한다 — 위 설명대로 externalBin은
  # "파일 존재"만 확인하므로, 이미 두 아키텍처를 모두 포함한 universal 바이너리 하나로
  # aarch64/x86_64 두 트리플 요구사항을 동시에 만족시킬 수 있다.
  cp "$HELPER_SRC" src-tauri/binaries/audio-device-helper-aarch64-apple-darwin
  cp "$HELPER_SRC" src-tauri/binaries/audio-device-helper-x86_64-apple-darwin
  chmod +x src-tauri/binaries/audio-device-helper-aarch64-apple-darwin \
    src-tauri/binaries/audio-device-helper-x86_64-apple-darwin
  echo "✓ 사이드카 배치: audio-device-helper-{aarch64,x86_64}-apple-darwin (universal binary 1개를 두 이름으로)"
fi

if [[ "$WINDOWS_ONLY" == "true" ]]; then
  HELPER_SRC="native/windows/audio-device-helper/dist/audio-device-helper.exe"
  if [[ ! -f "$HELPER_SRC" ]]; then
    echo "✗ $HELPER_SRC 가 없습니다." >&2
    exit 1
  fi
  # 트리플은 rustc 호스트 트리플과 일치해야 한다(계획서 5.9: "rustc -vV | grep host 또는
  # tauri build --target과 일치시킬 것"). rustup 기본 Windows 설치는 보통 MSVC 툴체인이라
  # x86_64-pc-windows-msvc를 기본값으로 쓰되, 실제 rustc가 있으면 그 값으로 덮어쓴다
  # (GNU 툴체인으로 설치된 환경이면 x86_64-pc-windows-gnu가 나올 수 있다).
  #
  # ⚠️ WINDOWS_CROSS(WSL/Linux 호스트)에서는 이 덮어쓰기 로직을 절대 타면 안 된다 — 여기서
  # rustc는 *호스트*(리눅스) 툴체인이라 `rustc -vV`의 host가 x86_64-unknown-linux-gnu로
  # 나온다. 그 값으로 덮어쓰면 사이드카 파일명이 x86_64-unknown-linux-gnu.exe가 되어 버려서
  # (실제로 겪은 버그) --target으로 명시한 x86_64-pc-windows-msvc와 어긋나 번들이
  # "externalBin 파일 없음"으로 실패한다. 크로스 경로에서는 --target 값이 곧 정답이므로
  # 항상 고정한다.
  TARGET_TRIPLE="x86_64-pc-windows-msvc"
  if [[ "$WINDOWS_CROSS" != "true" ]] && command -v rustc >/dev/null 2>&1; then
    ACTUAL_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
    if [[ -n "$ACTUAL_TRIPLE" && "$ACTUAL_TRIPLE" != "$TARGET_TRIPLE" ]]; then
      echo "⚠ rustc 호스트 트리플($ACTUAL_TRIPLE)이 기본값($TARGET_TRIPLE)과 달라 사이드카 이름을 여기 맞춥니다." >&2
      TARGET_TRIPLE="$ACTUAL_TRIPLE"
    fi
  fi
  cp "$HELPER_SRC" "src-tauri/binaries/audio-device-helper-${TARGET_TRIPLE}.exe"
  echo "✓ 사이드카 배치: audio-device-helper-${TARGET_TRIPLE}.exe"
fi

if [[ "$LINUX_ONLY" == "true" ]]; then
  echo "▶ Linux 타깃 — 사이드카 배치 없음 (기본 tauri.conf.json에 externalBin 자체가 없다," \
    "Linux는 네이티브 오디오 헬퍼가 아직 없어 audioDevice/audioCapture는 unsupported-platform)"
fi

# ===== 플랫폼별 산출물 저장 디렉터리 초기화 =====
mkdir -p dist-tauri/{mac,windows,linux}

echo ""
echo "▶ Tauri 패키징 시작..."
echo ""

# ===== macOS 패키징 =====
if [[ "$MAC_ONLY" == "true" ]]; then
  echo "▶ macOS 패키징 중 (호스트 아키텍처만 — 아래 참고)..."
  #
  # 왜 두 아키텍처(app) 자체를 다 안 뽑는가: `tauri build --target aarch64-apple-darwin`처럼
  # 아키텍처를 지정하려면 그 rustup target이 미리 설치돼 있어야 하는데(rustup target add),
  # 모든 개발 머신에 있다는 보장이 없다. 헬퍼(위)는 이미 lipo universal이라 어느 아키텍처
  # 사용자든 같은 헬퍼를 쓸 수 있지만, 앱 실행 파일 자체는 이 스크립트가 호스트 아키텍처로만
  # 만든다 — "정직하게 되는 것만 만든다" 원칙(헤더 주석 참고). 두 아키텍처 앱을 각각 뽑고
  # 싶으면 `rustup target add aarch64-apple-darwin x86_64-apple-darwin` 후 이 스크립트
  # 대신 `npx tauri build --target <triple>`을 타깃별로 직접 두 번 실행하면 된다(추후 과제).
  rm -rf dist-tauri/mac/* 2>/dev/null || true
  npx tauri build

  # ── 오디오 입력 entitlement 검증 (앱 본체 + 사이드카) ──────────────────────────
  # tauri.macos.conf.json에 signingIdentity가 있으면 Tauri는 hardened runtime
  # (--options runtime)으로 서명한다. 그 상태에서 com.apple.security.device.audio-input이
  # 없으면 CoreAudio는 **에러 대신 무음(전 샘플 0)** 을 준다 — 앱은 멀쩡히 돌고 캡처도 도는
  # 것처럼 보이는데 채널 파형만 "no signal (all zeros)"가 된다(ChannelRowHeader.tsx).
  # 실제로 IOProc을 여는 건 사이드카 헬퍼 프로세스이고 entitlement 검사는 바이너리 단위라,
  # 앱 본체에만 붙어서는 소용이 없다 — 그래서 둘 다 확인한다.
  #
  # 여기서 조용히 재서명하지 않고 빌드를 세우는 이유: 이 시점엔 .dmg가 이미 같은 서명으로
  # 만들어진 뒤라 .app만 고쳐봐야 dmg는 그대로 마이크가 먹통인 채로 남는다. 설정이 깨진
  # 것을 그때그때 덮는 대신 즉시 드러내는 편이 낫다(ASIO 헬퍼 재빌드 실패 처리와 같은 원칙).
  BUNDLE_APP="$(find src-tauri/target/release/bundle/macos -maxdepth 1 -type d -name "*.app" | head -1)"
  if [[ -n "$BUNDLE_APP" ]]; then
    MISSING=""
    for BIN in "$BUNDLE_APP" "$BUNDLE_APP/Contents/MacOS/audio-device-helper"; do
      [[ -e "$BIN" ]] || continue
      if ! codesign -d --entitlements - --xml "$BIN" 2>/dev/null | grep -q "com.apple.security.device.audio-input"; then
        MISSING="${MISSING} $(basename "$BIN")"
      fi
    done
    if [[ -n "$MISSING" ]]; then
      echo "✗ 오디오 입력 entitlement 누락:${MISSING}" >&2
      echo "  hardened runtime에서 이게 빠지면 마이크 입력이 전부 0으로 들어와 채널 파형이" >&2
      echo "  'no signal (all zeros)'로만 뜹니다(에러는 안 납니다)." >&2
      echo "  src-tauri/Entitlements.plist 와 tauri.macos.conf.json 의 macOS.entitlements 설정을 확인하세요." >&2
      exit 1
    fi
    echo "✓ 오디오 입력 entitlement 확인: 앱 본체 + 사이드카(audio-device-helper)"
  fi

  find src-tauri/target/release/bundle/dmg -maxdepth 1 -type f -name "*.dmg" -exec cp {} dist-tauri/mac/ \; 2>/dev/null || true
  find src-tauri/target/release/bundle/macos -maxdepth 1 -type d -name "*.app" -exec cp -R {} dist-tauri/mac/ \; 2>/dev/null || true
  echo ""
  echo "✓ Tauri 패키징 완료 (mac 전용): dist-tauri/mac/"
  ls -lh dist-tauri/mac/ 2>/dev/null | grep -v "^total" | awk '{printf "    %-60s %8s\n", $9, $5}' || true
  exit 0
fi

# ===== Windows 패키징 =====
if [[ "$WINDOWS_ONLY" == "true" ]]; then
  echo "▶ Windows 패키징 중..."
  rm -rf dist-tauri/windows/* 2>/dev/null || true
  if [[ "$WINDOWS_CROSS" == "true" ]]; then
    # cargo-xwin 크로스 경로 (실험적 — 위 헤더 주석 참고).
    # cargo-xwin은 보통 `cargo install cargo-xwin`으로 ~/.cargo/bin에 설치되는데, 비로그인
    # 셸(CI 등)에서는 PATH에 안 잡혀 있을 수 있어 여기서 한 번 더 보강한다.
    if ! command -v cargo-xwin >/dev/null 2>&1; then
      export PATH="$HOME/.cargo/bin:$PATH"
    fi
    if ! command -v cargo-xwin >/dev/null 2>&1; then
      echo "✗ cargo-xwin 을 찾을 수 없습니다. 'cargo install cargo-xwin' 로 설치하세요 (README 참고)." >&2
      exit 1
    fi
    # 실측 확인(2026-07, 이 리포에서 직접 검증 — 위 헤더 주석 참고): --target을 주면 CLI가
    # 호스트 OS가 아니라 --target 기준으로 tauri.windows.conf.json(externalBin 포함)을
    # 자동 병합한다. 그래서 --config를 별도로 넘길 필요가 없었다 — 만약 향후 tauri-cli
    # 버전에서 이 동작이 바뀌어 사이드카가 안 실리거나 externalBin 관련 에러가 나면
    # `--config tauri.windows.conf.json`을 명시적으로 추가해볼 것.
    #
    # 첫 실행은 cargo-xwin이 MS CRT/SDK를 ~/.cache에 내려받는다(네트워크 필요, 수 분 소요) —
    # 이후 실행은 캐시를 재사용해 훨씬 빠르다. lld-link가 PDB 심볼을 못 찾는다는
    # "failed to load reference ...pdb" 경고가 다수 나오는데, 이는 xwin이 전체 디버그
    # 심볼까지는 내려받지 않기 때문이며 빌드 결과물에는 영향 없다(무해).
    npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
    BUNDLE_DIR="src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis"
  else
    npx tauri build
    BUNDLE_DIR="src-tauri/target/release/bundle/nsis"
  fi
  find "$BUNDLE_DIR" -maxdepth 1 -type f -name "*.exe" -exec cp {} dist-tauri/windows/ \; 2>/dev/null || true
  echo ""
  if [[ "$WINDOWS_CROSS" == "true" ]]; then
    echo "✓ Tauri 패키징 완료 (windows 전용 — cargo-xwin 크로스, 실험적): dist-tauri/windows/"
    echo "  ⚠ 실제 배포 전에는 실기 Windows에서 설치/실행을 한 번 더 검증하는 것을 권장합니다."
  else
    echo "✓ Tauri 패키징 완료 (windows 전용): dist-tauri/windows/"
  fi
  ls -lh dist-tauri/windows/ 2>/dev/null | grep -v "^total" | awk '{printf "    %-60s %8s\n", $9, $5}' || true
  exit 0
fi

# ===== Linux 패키징 =====
echo "▶ Linux 패키징 중..."
rm -rf dist-tauri/linux/* 2>/dev/null || true
# Ubuntu 24.04+/WSL은 기본적으로 libfuse2가 없어서 linuxdeploy가 만드는 AppImage 런타임이
# FUSE로 마운트를 못 한다(Phase 6에서 실측). APPIMAGE_EXTRACT_AND_RUN=1은 그 대신 self-extract
# 방식으로 돌게 하는 표준 플래그 — FUSE가 있는 환경에서도 무해하다.
export APPIMAGE_EXTRACT_AND_RUN=1
npx tauri build
find src-tauri/target/release/bundle/appimage -maxdepth 1 -type f -name "*.AppImage" -exec cp {} dist-tauri/linux/ \; 2>/dev/null || true
echo ""
echo "✓ Tauri 패키징 완료 (linux 전용): dist-tauri/linux/"
ls -lh dist-tauri/linux/ 2>/dev/null | grep -v "^total" | awk '{printf "    %-60s %8s\n", $9, $5}' || true
