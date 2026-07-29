#!/usr/bin/env bash
# setup-wsl.sh — Iron Device Simulator 개발 환경 세팅 (WSL2/Linux 공용)
#
#   wsl bash scripts/setup-wsl.sh     # Windows PowerShell에서 WSL2로 위임할 때
#   bash scripts/setup-wsl.sh         # WSL2/Linux 셸 안에서 직접 실행할 때
#
# 이 리포의 빌드 스크립트(wasm:build, build:electron 등)는 전부 bash라 WSL2/Linux에서는
# 별도 변환 없이 그대로 동작한다 — 이 스크립트는 그 전제조건(Node/emcc/빌드 도구)만 갖춘다.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"

log()  { echo -e "\n▶ $*"; }
ok()   { echo "  ✓ $*"; }
warn() { echo "  ⚠ $*"; }

NODE_MIN_MAJOR=20

# ---------------------------------------------------------------------------
log "1/5 apt 패키지 확인 (build-essential, git, curl, python3)"
if command -v apt-get >/dev/null 2>&1; then
  NEED_PKGS=()
  for pkg in build-essential git curl python3 ca-certificates; do
    dpkg -s "$pkg" >/dev/null 2>&1 || NEED_PKGS+=("$pkg")
  done
  if [ "${#NEED_PKGS[@]}" -gt 0 ]; then
    echo "  설치 필요: ${NEED_PKGS[*]} (sudo 필요)"
    sudo apt-get update
    sudo apt-get install -y "${NEED_PKGS[@]}"
  else
    ok "이미 설치됨"
  fi
else
  warn "apt-get을 찾을 수 없습니다 — Debian/Ubuntu 계열이 아니면 이 단계는 배포판 패키지 매니저로 직접 준비하세요."
fi

# ---------------------------------------------------------------------------
log "2/5 Node.js ${NODE_MIN_MAJOR}+ 확인"
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  [ "$major" -ge "$NODE_MIN_MAJOR" ]
}

if node_ok; then
  ok "$(node -v) / npm $(npm -v)"
else
  warn "Node ${NODE_MIN_MAJOR}+ 가 없어 nvm으로 설치합니다."
  export NVM_DIR="$HOME/.nvm"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh"
  nvm install --lts
  nvm use --lts
  ok "$(node -v) / npm $(npm -v)"
  warn "새 터미널에서는 nvm이 자동 로드되도록 ~/.bashrc / ~/.zshrc 를 확인하세요."
fi

# ---------------------------------------------------------------------------
log "3/5 Emscripten (emcc) 확인 — WASM 엔진 빌드에 필요"
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
  for RC in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$RC" ] || continue
    grep -qF "$SOURCE_LINE" "$RC" 2>/dev/null || {
      echo "$SOURCE_LINE" >> "$RC"
      ok "$RC 에 emsdk 환경 로드 라인 추가"
    }
  done
  ok "$(emcc --version | head -1)"
fi

# ---------------------------------------------------------------------------
log "4/5 npm install"
npm install
ok "의존성 설치 완료"

# ---------------------------------------------------------------------------
log "5/5 WASM 엔진 빌드 (public/wasm/ff_prot.{js,wasm})"
npm run wasm:build
ok "WASM 빌드 완료"

# ---------------------------------------------------------------------------
cat <<EOF

✓ 셋업 완료: $ROOT

다음 단계:
  npm run dev              # http://localhost:3000 (UI 확인 전용 — 오디오 캡처/재생은 Electron 브리지가 없어 동작하지 않음)
  npm run build:electron   # Electron 패키징 (dist-electron/) — WSL2에서는 GUI 실행에 WSLg(Win11) 필요

참고:
  - Electron 창을 WSL2 안에서 직접 띄우려면(electron:preview 등) Windows 11 + WSLg가 필요합니다.
  - 이 앱은 Electron 전용입니다 — 웹 전용 캡처 폴백(getUserMedia)은 제거됐습니다. Linux용 네이티브
    오디오 헬퍼(window.audioDevice/audioCapture)가 아직 없어서(docs/windows-plan.md 참고) WSL2/Linux에서는
    오디오 캡처/재생 자체를 테스트할 수 없고, WSLg로 띄운 Electron 창의 UI만 확인할 수 있습니다.
EOF
