#!/usr/bin/env bash
# bootstrap.sh — 클론 직후 원커맨드 온보딩: 환경 확인 → npm install → WASM 엔진 빌드 → dev 서버.
#
#   npm run bootstrap        # (또는 bash scripts/setup/bootstrap.sh)
#
# 본인 C 알고리즘을 넣어 쓰는 흐름(electron/native/wasm-engine/README.md "내 알고리즘 넣기" 참고):
#   1) git clone → 2) 본인 .c/.h 를 electron/native/wasm-engine/custom/ 에 넣기(파일명 자유)
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

# ── 4. WASM 엔진 빌드 (electron/native/wasm-engine/*.c → public/wasm/) ──────
echo "→ npm run wasm:build"
npm run wasm:build

# ── 5. dev 서버 ─────────────────────────────────────────────────────────────
echo "✓ 준비 완료 — dev 서버를 시작합니다 (http://localhost:3000)"
exec npm run dev
