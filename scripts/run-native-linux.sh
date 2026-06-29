#!/bin/bash
# ─────────────────────────────────────────────────────────────
# iron-Device-simulater — Linux 서버 설치 & 실행 스크립트
#
# 사용법:
#   chmod +x setup-linux.sh
#   ./setup-linux.sh [libirontune.so 경로]
#
# 예시:
#   ./setup-linux.sh /home/user/libirontune.so
#   ./setup-linux.sh   ← .so 경로 생략 시 스크립트와 같은 디렉토리에서 탐색
# ─────────────────────────────────────────────────────────────

set -e

# ── 색상 출력 헬퍼 ────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}:arrow_forward: $*${NC}"; }
success() { echo -e "${GREEN}:heavy_check_mark: $*${NC}"; }
warn() { echo -e "${YELLOW}:warning: $*${NC}"; }
error() { echo -e "${RED}:heavy_multiplication_x: $*${NC}"; exit 1; }

# ── 요구 버전 ─────────────────────────────────────────────────
REQUIRED_NODE_MAJOR=20
REQUIRED_NPM_MAJOR=10

# ── .so 경로 결정 ─────────────────────────────────────────────
SO_PATH="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -z "$SO_PATH" ]; then
  # 인자 없으면 스크립트 디렉토리 및 상위 디렉토리에서 자동 탐색
  SEARCH_BASE="$(cd "$SCRIPT_DIR/../.." && pwd)"
  FOUND=$(find "$SEARCH_BASE" -maxdepth 3 -name "libirontune.so" 2>/dev/null | head -1)
  if [ -n "$FOUND" ]; then
    SO_PATH="$FOUND"
    warn "libirontune.so 자동 감지: $SO_PATH"
  fi
fi

# ── 플랫폼 확인 ───────────────────────────────────────────────
info "플랫폼 확인 중..."

OS=$(uname -s)
ARCH=$(uname -m)

[ "$OS" != "Linux" ]  && error "이 스크립트는 Linux 전용입니다. (현재: $OS)"
[ "$ARCH" != "x86_64" ] && error "libirontune.so는 x86-64 전용입니다. (현재: $ARCH)"

success "플랫폼 OK: $OS $ARCH"

# ── Node.js 버전 확인 및 설치 ─────────────────────────────────
install_node() {
  info "Node.js $REQUIRED_NODE_MAJOR 설치 중 (NodeSource)..."

  if command -v curl &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x | sudo -E bash -
  elif command -v wget &>/dev/null; then
    wget -qO- https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x | sudo -E bash -
  else
    error "curl 또는 wget이 필요합니다."
  fi

  sudo apt-get install -y nodejs
}

info "Node.js 버전 확인 중..."

if command -v node &>/dev/null; then
  NODE_MAJOR=$(node -e "process.stdout.write(process.version.split('.')[0].replace('v',''))")
  if [ "$NODE_MAJOR" -ge "$REQUIRED_NODE_MAJOR" ]; then
    success "Node.js $(node --version) — OK"
  else
    warn "Node.js $(node --version) 감지됨. v${REQUIRED_NODE_MAJOR} 이상 필요. 업그레이드합니다..."
    install_node
    success "Node.js $(node --version) 설치 완료"
  fi
else
  warn "Node.js 없음. 설치합니다..."
  install_node
  success "Node.js $(node --version) 설치 완료"
fi

# npm 버전 확인
NPM_MAJOR=$(npm -v | cut -d. -f1)
if [ "$NPM_MAJOR" -lt "$REQUIRED_NPM_MAJOR" ]; then
  info "npm 업그레이드 중..."
  sudo npm install -g npm@latest
fi

# ── ffmpeg 설치 확인 ──────────────────────────────────────────
info "ffmpeg 확인 중..."

if command -v ffmpeg &>/dev/null; then
  success "ffmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}') — OK"
else
  warn "ffmpeg 없음. 설치합니다..."
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends ffmpeg
  success "ffmpeg 설치 완료"
fi

# ── .so 파일 확인 ─────────────────────────────────────────────
info "libirontune.so 확인 중..."

if [ -z "$SO_PATH" ]; then
  warn "libirontune.so 경로가 지정되지 않았습니다."
  warn "USE_MOCK=true 모드로 실행합니다."
  warn "나중에 .so를 사용하려면: SO_PATH=/path/to/libirontune.so npx tsx server.ts"
  USE_MOCK=true
else
  if [ ! -f "$SO_PATH" ]; then
    error "파일을 찾을 수 없습니다: $SO_PATH"
  fi

  # ELF x86-64 바이너리인지 검증
  FILE_INFO=$(file "$SO_PATH" 2>/dev/null || echo "")
  if echo "$FILE_INFO" | grep -q "ELF 64-bit.*x86-64"; then
    success "libirontune.so OK: $SO_PATH"
    USE_MOCK=false
  else
    warn "파일 형식이 예상과 다릅니다: $FILE_INFO"
    warn "USE_MOCK=true 모드로 실행합니다."
    USE_MOCK=true
  fi

  # ldd로 링크 의존성 확인
  info "공유 라이브러리 의존성 확인 중..."
  MISSING=$(ldd "$SO_PATH" 2>/dev/null | grep "not found" || true)
  if [ -n "$MISSING" ]; then
    warn "누락된 공유 라이브러리:"
    echo "$MISSING"
    warn "위 라이브러리를 설치한 후 다시 실행하세요."
  fi
fi

# ── npm 의존성 설치 ───────────────────────────────────────────
info "npm 의존성 설치 중..."
cd "$SCRIPT_DIR/.."
npm ci
success "의존성 설치 완료"

# ── Next.js 빌드 ──────────────────────────────────────────────
info "Next.js 빌드 중..."
npm run build
success "빌드 완료"

# ── 실행 ──────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$USE_MOCK" = true ]; then
  warn "Mock 모드로 실행합니다 (libirontune.so 없음)"
  echo ""
  info "서버 시작: http://localhost:3000"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  USE_MOCK=true npx tsx server.ts
else
  success "Native 모드로 실행합니다"
  echo "  SO_PATH: $SO_PATH"
  echo ""
  info "서버 시작: http://localhost:3000"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  USE_MOCK=false SO_PATH="$SO_PATH" npx tsx server.ts
fi
