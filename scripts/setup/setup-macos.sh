#!/usr/bin/env bash
# setup-macos.sh — Iron Device Simulator 개발 환경 세팅 (macOS 네이티브)
#
#   bash scripts/setup-macos.sh
#
# 이 리포의 빌드 스크립트(wasm:build, build:tauri ...)는 전부 bash라
# macOS 기본 터미널(zsh/bash)에서 별도 변환 없이 그대로 동작한다 — 이 스크립트는 그
# 전제조건(Xcode CLT/Node/emcc)만 갖추고, 선택적으로 macOS 전용 CoreAudio 캡처 헬퍼까지
# 미리 빌드해둔다.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"

log()  { echo -e "\n▶ $*"; }
ok()   { echo "  ✓ $*"; }
warn() { echo "  ⚠ $*"; }

if [[ "$(uname)" != "Darwin" ]]; then
  echo "✗ 이 스크립트는 macOS 전용입니다. Linux/WSL2는 scripts/setup-wsl.sh 를 사용하세요(Windows는 WSL2 경유 권장)." >&2
  exit 1
fi

NODE_MIN_MAJOR=20

# ---------------------------------------------------------------------------
log "1/6 Xcode Command Line Tools 확인 (git / clang / swiftc — CoreAudio 헬퍼 빌드에 필요)"
if xcode-select -p >/dev/null 2>&1; then
  ok "설치됨: $(xcode-select -p)"
else
  warn "설치되어 있지 않아 설치를 시작합니다 (GUI 설치창이 뜹니다)."
  xcode-select --install
  echo "  설치가 끝난 뒤 이 스크립트를 다시 실행하세요." >&2
  exit 0
fi

# ---------------------------------------------------------------------------
log "2/6 Node.js ${NODE_MIN_MAJOR}+ 확인"
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  [ "$major" -ge "$NODE_MIN_MAJOR" ]
}

if node_ok; then
  ok "$(node -v) / npm $(npm -v)"
elif command -v brew >/dev/null 2>&1; then
  warn "Node ${NODE_MIN_MAJOR}+ 가 없어 Homebrew로 설치합니다."
  brew install node
  ok "$(node -v) / npm $(npm -v)"
else
  warn "Node ${NODE_MIN_MAJOR}+ 가 없고 Homebrew도 없어 nvm으로 설치합니다."
  export NVM_DIR="$HOME/.nvm"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh"
  nvm install --lts
  nvm use --lts
  ok "$(node -v) / npm $(npm -v)"
  warn "새 터미널에서는 nvm이 자동 로드되도록 ~/.zshrc / ~/.bashrc 를 확인하세요."
fi

# ---------------------------------------------------------------------------
log "3-1/6 Java(JRE) 확인 — 배포 하드닝 빌드의 글루 JS 압축(--closure 1)에 필요"
# build:desktop / build:tauri* 는 FF_PROT_HARDEN=1 로 emcc 를 돌리는데(난독화 체인),
# 그 안의 --closure 1(Closure Compiler)은 Java 런타임을 필요로 한다(native/wasm-engine/build-wasm.sh
# 참고). Docker(emscripten/emsdk) 폴백으로 빌드하면 이미지에 Java 가 들어 있어 무관하지만,
# 로컬 emcc 로 하드닝 빌드를 하면 Java 가 없을 때 이 단계에서 실패한다.
if command -v java >/dev/null 2>&1; then
  ok "$(java -version 2>&1 | head -1)"
elif command -v brew >/dev/null 2>&1; then
  warn "Java 가 없어 Homebrew(openjdk)로 설치합니다."
  brew install openjdk
  # brew openjdk 는 keg-only 라 자동으로 PATH 에 안 잡힌다 — 시스템 JavaVM 심볼릭 링크를 건다.
  JDK_LINK="/Library/Java/JavaVirtualMachines/openjdk.jdk"
  JDK_SRC="$(brew --prefix)/opt/openjdk/libexec/openjdk.jdk"
  if [ -d "$JDK_SRC" ] && [ ! -e "$JDK_LINK" ]; then
    warn "openjdk 를 시스템 JavaVM 위치에 연결합니다 (sudo 필요)."
    sudo ln -sfn "$JDK_SRC" "$JDK_LINK" || warn "심볼릭 링크 실패 — 'brew info openjdk' 안내대로 PATH 를 직접 잡으세요."
  fi
  if command -v java >/dev/null 2>&1; then
    ok "$(java -version 2>&1 | head -1)"
  else
    warn "java 가 아직 PATH 에 없습니다 — 'brew info openjdk' 안내대로 PATH 를 잡은 뒤 새 터미널에서 확인하세요."
  fi
else
  warn "Java 가 없고 Homebrew 도 없습니다 — 배포 하드닝 빌드(build:desktop/build:tauri*)의 --closure 1 단계에 필요합니다."
  echo "      https://adoptium.net 에서 Temurin JRE 를 설치하거나, Docker 로 빌드하면(emscripten/emsdk 이미지에 Java 포함) 우회됩니다." >&2
fi

# ---------------------------------------------------------------------------
log "3/6 Emscripten (emcc) 확인 — WASM 엔진 빌드에 필요"
if command -v emcc >/dev/null 2>&1; then
  ok "$(emcc --version | head -1)"
else
  EMSDK_DIR="$HOME/emsdk"
  if [ ! -d "$EMSDK_DIR" ]; then
    warn "emsdk 클론: $EMSDK_DIR"
    git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
  fi
  (
    cd "$EMSDK_DIR"
    ./emsdk install latest
    ./emsdk activate latest
  )
  # shellcheck disable=SC1091
  source "$EMSDK_DIR/emsdk_env.sh"

  SOURCE_LINE="source \"$EMSDK_DIR/emsdk_env.sh\" >/dev/null 2>&1"
  for RC in "$HOME/.zshrc" "$HOME/.bashrc"; do
    [ -f "$RC" ] || continue
    grep -qF "$SOURCE_LINE" "$RC" 2>/dev/null || {
      echo "$SOURCE_LINE" >> "$RC"
      ok "$RC 에 emsdk 환경 로드 라인 추가"
    }
  done
  ok "$(emcc --version | head -1)"
fi

# ---------------------------------------------------------------------------
log "4/6 npm install"
npm install
ok "의존성 설치 완료"

# ---------------------------------------------------------------------------
log "5/6 WASM 엔진 빌드 (public/wasm/ff_prot.{js,wasm})"
npm run wasm:build
ok "WASM 빌드 완료"

# ---------------------------------------------------------------------------
log "6/6 (선택) macOS CoreAudio 캡처 헬퍼 빌드 — Tauri 네이티브 마이크/장치 제어에만 필요"
if ./native/macos/audio-device-helper/build-mac.sh; then
  ok "audio-device-helper 빌드 완료 (native/macos/audio-device-helper/dist/)"
else
  warn "audio-device-helper 빌드 실패 — npm run dev(UI 확인 전용)는 영향 없습니다. 필요 시 나중에 다시 실행하세요."
fi

# ---------------------------------------------------------------------------
# Rust 툴체인 확인 — Tauri 데스크톱 셸(build:tauri*, tauri:preview) 빌드에 필요하다.
# npm run dev(UI 확인)는 cargo 없이도 되므로 여기서도 실패시키지 않고 안내만 한다.
if ! command -v cargo >/dev/null 2>&1; then
  warn "Rust 툴체인(cargo) 없음 — npm run dev(UI 확인)는 그대로 되지만 Tauri 빌드/미리보기(build:tauri*, tauri:preview)는 https://rustup.rs 설치가 필요합니다 (macOS는 Xcode Command Line Tools 외 추가 시스템 패키지 불필요)."
else
  ok "$(cargo --version)"
fi

# ---------------------------------------------------------------------------
# (선택) wasm-tools — WASM 하드닝 빌드(FF_PROT_HARDEN=1)의 구조 변형(wasm-mutate) 단계에 쓰인다.
# 없으면 그 단계만 비파괴적으로 건너뛰므로 필수는 아니다. cargo가 있을 때만 설치를 시도하고
# (컴파일에 수 분 소요), 실패해도 세팅 전체를 중단하지 않는다.
if command -v wasm-tools >/dev/null 2>&1; then
  ok "wasm-tools 있음: $(wasm-tools --version)"
elif command -v cargo >/dev/null 2>&1; then
  warn "wasm-tools 없음 — WASM 하드닝의 구조 변형(wasm-mutate)에 쓰입니다. cargo로 설치를 시도합니다(수 분 소요)."
  if cargo install wasm-tools; then
    ok "$(wasm-tools --version) 설치 완료"
  else
    warn "wasm-tools 설치 실패 — 하드닝 빌드는 이 단계를 건너뛰고 진행됩니다(치명적 아님). 나중에 'cargo install wasm-tools'로 재시도하세요."
  fi
else
  warn "wasm-tools 없음(cargo도 없음) — WASM 하드닝의 구조 변형은 건너뜁니다. 필요하면 Rust 설치 후 'cargo install wasm-tools'."
fi

# ---------------------------------------------------------------------------
cat <<EOF

✓ 셋업 완료: $ROOT

다음 단계:
  npm run dev               # http://localhost:3000 (UI 확인 전용 — 오디오 캡처/재생은 Tauri 브리지가 없어 동작하지 않음)
  npm run build:tauri:mac   # Tauri 패키징, macOS 전용 (dist-tauri/mac/, 네이티브 CoreAudio 헬퍼 포함)
  npm run tauri:preview     # npx tauri dev — 패키징 없이 out/ 기준으로 실행 (먼저 npm run build:desktop 필요)

참고:
  - 이 앱은 Tauri 전용입니다 — 웹 전용 캡처 폴백(getUserMedia)은 제거됐습니다. 오디오 캡처/재생을
    테스트하려면 반드시 tauri:preview 또는 패키징된 앱으로 실행해야 합니다.
  - 방금 빌드한 audio-device-helper는 소스(mac.swift)가 바뀔 때마다 다시 빌드해야 합니다
    (npm run build:tauri / build:tauri:mac 이 자동으로 다시 빌드합니다).
EOF
