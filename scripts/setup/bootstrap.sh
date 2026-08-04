#!/usr/bin/env bash
# bootstrap.sh — 클론 직후 원커맨드 온보딩: 환경 확인 → npm install → WASM 엔진 빌드 → dev 서버.
#
#   npm run bootstrap                  # (또는 bash scripts/setup/bootstrap.sh)
#   BOOTSTRAP_NO_DEV=1 npm run bootstrap   # dev 서버 자동 실행 없이 준비만
#
# ⚠️ 엔진 C 소스는 이 저장소에 없다 — native/wasm-engine/.gitignore 가 *.c/*.h 를 제외하므로
#    신규 클론에는 빌드할 소스가 한 개도 없다. 본인 알고리즘을 직접 넣어야 한다:
#   1) git clone → 2) 본인 .c/.h 를 native/wasm-engine/custom/ 에 넣기(파일명 자유,
#      export 심볼 ff_prot_* 4개는 유지 — native/wasm-engine/custom/README.md)
#   → 3) npm run bootstrap
#   소스가 없어도 이 스크립트는 실패하지 않는다 — npm install 까지만 하고 엔진 빌드를
#   건너뛴 뒤, 무엇을 넣어야 하는지 안내하고 끝낸다.
#
# emcc(Emscripten)가 없어도 Docker만 있으면 됨 — build-wasm.sh 가 emscripten/emsdk
# 이미지로 자동 폴백한다. 둘 다 없을 때만 아래에서 미리 안내하고 중단.
set -euo pipefail
cd "$(dirname "$0")/../.."

ENGINE_DIR="native/wasm-engine"

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

# ── 2. 엔진 C 소스 유무 ─────────────────────────────────────────────────────
# build-wasm.sh 의 소스 선택 우선순위(① FF_PROT_SRCS → ② custom/*.c → ③ 폴더 내 *.c,
# selftest 계열 제외)를 그대로 흉내 낸다. 여기서 미리 판정해야 "npm install 다 해놓고
# 마지막에 ✗ 컴파일할 .c 소스가 없습니다 로 죽는" 흐름을 피할 수 있다.
detect_engine_src() {
  [[ -n "${FF_PROT_SRCS:-}" ]] && return 0
  local f found=1
  shopt -s nullglob
  for f in "$ENGINE_DIR"/custom/*.c "$ENGINE_DIR"/*.c; do
    [[ "$f" == *selftest* ]] && continue
    found=0
    break
  done
  shopt -u nullglob
  return $found
}
HAS_ENGINE_SRC=0
detect_engine_src || HAS_ENGINE_SRC=1

# ── 3. emcc 또는 docker (WASM 빌드 수단) ────────────────────────────────────
# 엔진 소스가 있을 때만 하드 실패한다 — 소스가 없으면 어차피 이번 회차엔 안 쓴다.
if [ "$HAS_ENGINE_SRC" -eq 0 ]; then
  if ! command -v emcc >/dev/null 2>&1 && ! command -v docker >/dev/null 2>&1; then
    echo "✗ emcc(Emscripten)도 docker도 없습니다. 둘 중 하나를 준비하세요:" >&2
    echo "   - Emscripten 설치: bash scripts/setup/setup-macos.sh (macOS) / bash scripts/setup/setup-wsl.sh (WSL2·Linux)" >&2
    echo "   - 또는 Docker 설치 (build-wasm.sh 가 emscripten/emsdk 이미지로 자동 빌드)" >&2
    exit 1
  fi
fi

# ── 4. 의존성 설치 ──────────────────────────────────────────────────────────
echo "→ npm install"
npm install

# ── 5. WASM 엔진 빌드 (native/wasm-engine/custom/*.c → public/wasm/) ────────
# 하드닝(FF_PROT_HARDEN=1, wasm-opt 스트립 + 상수 XOR 난독화 + 글루 JS 난독화)은 배포
# 빌드(build:desktop/build:tauri*)에서 자동으로 켜진다. 여기서 도는 단독 wasm:build 는
# 기본 꺼짐 — custom/*.c 를 반복 수정하는 동안 디버깅 편의를 유지하기 위해서다.
if [ "$HAS_ENGINE_SRC" -eq 0 ]; then
  echo "→ npm run wasm:build"
  npm run wasm:build
else
  cat <<EOF

⚠ 엔진 C 소스가 없어 WASM 빌드를 건너뜁니다.
  이 저장소는 알고리즘 소스를 포함하지 않습니다($ENGINE_DIR/.gitignore).

  본인 .c/.h 를 아래 폴더에 넣고 다시 실행하세요(파일명 제약 없음):
      $ENGINE_DIR/custom/
      → 계약: ff_prot_init / ff_prot_set_param / ff_prot_start_exec(9-인자) /
        ff_prot_stop_exec 4개를 export (자세히: $ENGINE_DIR/custom/README.md)

      npm run bootstrap     # 또는 엔진만: npm run wasm:build
EOF
fi

# ── 6. (선택, 비차단) Rust 툴체인 — Tauri 데스크톱 셸 빌드에만 필요 ──────────
# npm run dev(UI 확인 전용) 워크플로는 여기서 아무것도 필요 없다 — cargo가 없어도 이
# 온보딩은 절대 실패하지 않는다. 다만 오디오 캡처/재생을 실제로 테스트하려면 Tauri
# 데스크톱 셸이 유일한 경로이므로 결국 필요해진다 — 없는 사람에게만 미리 안내한다.
if ! command -v cargo >/dev/null 2>&1; then
  cat <<'EOF'

ℹ Rust 툴체인(cargo)이 없습니다 — npm run dev(UI 확인 전용)는 이 상태로도 전혀 문제
  없지만, 오디오 캡처/재생까지 테스트하려면 Tauri 데스크톱 셸(build:tauri*,
  tauri:preview, wasm:preview)이 유일한 경로라 결국 필요합니다. 준비 방법:
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
elif ! command -v wasm-tools >/dev/null 2>&1; then
  cat <<'EOF'

ℹ (선택) wasm-tools 가 없습니다 — 배포 하드닝 빌드에서 구조 변형(wasm-mutate) 단계만
  조용히 건너뜁니다. 상수 난독화·스트립은 그대로 적용되며 빌드는 실패하지 않습니다.
      cargo install wasm-tools
EOF
fi

# ── 7. 마무리 ───────────────────────────────────────────────────────────────
if [ "$HAS_ENGINE_SRC" -ne 0 ]; then
  echo
  echo "✓ 의존성 설치 완료 — 엔진 소스를 넣은 뒤 다시 실행하세요 (위 안내 참고)."
  echo "  UI만 먼저 보려면: npm run dev   (분석은 동작하지 않습니다 — 엔진 없음)"
  exit 0
fi

cat <<'EOF'

✓ 준비 완료.

  npm run dev            http://localhost:3000 — UI 확인 전용.
                         브라우저에는 window.audioDevice/audioCapture 브리지가 없어
                         오디오 캡처·재생은 동작하지 않습니다.

  실제 캡처/재생까지 확인하려면 (Tauri 셸이 유일한 경로):
  npm run build:desktop && npm run tauri:preview    # Rust/IPC 변경까지 반영
  npm run wasm:preview                              # 알고리즘(.c)만 바꿨을 때 빠른 확인
  npm run build:tauri:mac                           # 패키징 (→ dist-tauri/mac/)
EOF

if [ -n "${BOOTSTRAP_NO_DEV:-}" ]; then
  exit 0
fi
echo
echo "→ dev 서버를 시작합니다 (Ctrl+C 로 종료)"
exec npm run dev
