#!/usr/bin/env bash
# setup-macos.sh — Iron Device Simulator 개발 환경 세팅 (macOS 네이티브)
#
#   bash scripts/setup-macos.sh
#
# 이 리포의 빌드 스크립트(wasm:build, build:desktop, build:electron ...)는 전부 bash라
# macOS 기본 터미널(zsh/bash)에서 별도 변환 없이 그대로 동작한다 — 이 스크립트는 그
# 전제조건(Xcode CLT/Node/emcc)만 갖추고, 선택적으로 macOS 전용 CoreAudio 캡처 헬퍼까지
# 미리 빌드해둔다.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

log()  { echo -e "\n▶ $*"; }
ok()   { echo "  ✓ $*"; }
warn() { echo "  ⚠ $*"; }

if [[ "$(uname)" != "Darwin" ]]; then
  echo "✗ 이 스크립트는 macOS 전용입니다. Linux/WSL2는 scripts/setup-wsl.sh, Windows는 scripts/setup-windows.ps1 을 사용하세요." >&2
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
log "6/6 (선택) macOS CoreAudio 캡처 헬퍼 빌드 — Electron 네이티브 마이크/장치 제어에만 필요"
if ./electron/native/audio-device-helper/build-mac.sh; then
  ok "audio-device-helper 빌드 완료 (electron/native/audio-device-helper/dist/)"
else
  warn "audio-device-helper 빌드 실패 — npm run dev(브라우저 getUserMedia 폴백)는 영향 없습니다. 필요 시 나중에 다시 실행하세요."
fi

# ---------------------------------------------------------------------------
cat <<EOF

✓ 셋업 완료: $ROOT

다음 단계:
  npm run dev                # http://localhost:3000 (브라우저 WASM 엔진)
  npm run build:desktop      # 정적 번들 (out/)
  npm run build:electron:mac # Electron 패키징, macOS 전용 (dist-electron/, 네이티브 CoreAudio 헬퍼 포함)
  npm run electron:preview   # electron . — 패키징 없이 out/ 기준으로 실행

참고:
  - 네이티브 오디오 캡처(window.audioDevice/audioCapture)는 macOS에서만 동작합니다 — Electron
    패키징/미리보기에서만 쓰이고, npm run dev(웹)에서는 getUserMedia 폴백이 항상 동작합니다.
  - 방금 빌드한 audio-device-helper는 소스(mac.swift)가 바뀔 때마다 다시 빌드해야 합니다
    (npm run build:electron / build:electron:mac 이 자동으로 다시 빌드합니다).
EOF
