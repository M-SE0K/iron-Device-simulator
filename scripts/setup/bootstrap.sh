#!/usr/bin/env bash
# bootstrap.sh — 클론 직후 원커맨드 온보딩: 환경 확인 → npm install → WASM 엔진 빌드 → dev 서버.
#
#   npm run bootstrap        # (또는 bash scripts/setup/bootstrap.sh)
#
# 본인 C 알고리즘을 넣어 쓰는 흐름(native/wasm-engine/README.md "내 알고리즘 넣기" 참고):
#   1) git clone → 2) 본인 .c/.h 를 native/wasm-engine/custom/ 에 넣기(파일명 자유)
#   → 3) npm run bootstrap → http://localhost:3000
#
# emcc(Emscripten)가 없어도 Docker만 있으면 됨 — build-wasm.sh 가 emscripten/emsdk
# 이미지로 자동 폴백한다. 둘 다 없을 때만 아래에서 미리 안내하고 중단.
set -euo pipefail
cd "$(dirname "$0")/../.."

# ── 1. Node.js 20+ / npm ────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "✗ Node.js/npm이 없습니다 (Node 20+ 필요)." >&2
  echo "   macOS: bash scripts/setup/setup-macos.sh / WSL2·Linux: bash scripts/setup/setup-wsl.sh" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "✗ Node.js 20+ 필요 (현재: $(node -v))." >&2
  exit 1
fi

# ── 2. emcc 또는 docker (WASM 빌드 수단) ────────────────────────────────────
if ! command -v emcc >/dev/null 2>&1 && ! command -v docker >/dev/null 2>&1; then
  echo "✗ emcc(Emscripten)도 docker도 없습니다. 둘 중 하나를 준비하세요:" >&2
  echo "   - Emscripten 설치: bash scripts/setup/setup-macos.sh (macOS) / bash scripts/setup/setup-wsl.sh (WSL2·Linux)" >&2
  echo "   - 또는 Docker 설치 (build-wasm.sh 가 emscripten/emsdk 이미지로 자동 빌드)" >&2
  exit 1
fi

# ── 3. 의존성 설치 ──────────────────────────────────────────────────────────
echo "→ npm install"
npm install

# ── 4. WASM 엔진 빌드 (native/wasm-engine/*.c → public/wasm/) ──────
echo "→ npm run wasm:build"
npm run wasm:build

# ── 4.5. (선택, 비차단) Rust 툴체인 확인 — Tauri 데스크톱 셸 빌드에만 필요 ────────
# Electron만 쓰는 워크플로(dev/build:desktop/build:electron*)는 여기서 아무것도
# 필요 없다 — cargo가 없어도 이 온보딩은 절대 실패하지 않는다. Tauri 빌드/미리보기
# (build:tauri*, tauri:preview, wasm:preview:tauri*)를 쓰려는 사람에게만 안내한다.
if ! command -v cargo >/dev/null 2>&1; then
  cat <<'EOF'

ℹ Rust 툴체인(cargo)이 없습니다 — Electron 전용 워크플로(dev/build:desktop/build:electron*)는
  이 상태로도 전혀 문제 없습니다. Tauri 데스크톱 셸(build:tauri*, tauri:preview,
  wasm:preview:tauri*)까지 쓰려면 나중에 아래를 준비하세요:
    - Rust: https://rustup.rs
    - Linux/WSL 추가 패키지 (Tauri v2 WebKitGTK 의존):
        sudo apt install libwebkit2gtk-4.1-dev pkg-config libssl-dev \
          librsvg2-dev libxdo-dev libayatana-appindicator3-dev
    - macOS/Windows는 Xcode Command Line Tools / Visual Studio Build Tools 정도면 충분합니다.
    - (선택) WSL/Linux에서 build:tauri:windows까지 실기 Windows 없이 돌리고 싶다면
      (cargo-xwin + NSIS를 쓰는 Tauri의 실험적 크로스 컴파일 경로, README 참고):
        rustup target add x86_64-pc-windows-msvc
        cargo install cargo-xwin
        sudo apt install nsis clang lld llvm
EOF
fi

# ── 5. dev 서버 ─────────────────────────────────────────────────────────────
echo "✓ 준비 완료 — dev 서버를 시작합니다 (http://localhost:3000)"
exec npm run dev
