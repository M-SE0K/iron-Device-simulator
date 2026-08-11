#!/usr/bin/env bash
# bootstrap.sh — 클론 직후 원커맨드 온보딩: 환경 확인 → npm install → WASM 엔진 빌드 →
#                dev 서버 기동 확인(스모크 테스트) 후 자동 종료.
#
#   npm run bootstrap                             # 전체 (dev 서버는 응답 확인 후 자동 종료)
#   BOOTSTRAP_NO_DEV=1 npm run bootstrap          # dev 서버 확인 없이 준비만
#   BOOTSTRAP_DEV_TIMEOUT=180 npm run bootstrap   # 느린 머신에서 대기 시간 늘리기(기본 90초)
#   BOOTSTRAP_NO_AUTO_INSTALL=1 npm run bootstrap # 툴체인 자동 설치 없이 안내만 (6-4장)
#   BOOTSTRAP_APT_INSTALL=1 npm run bootstrap     # sudo 가 필요한 apt 패키지까지 설치 (6-4장)
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

UNAME_S="$(uname -s)"
case "$UNAME_S" in
  Darwin)               HOST_OS="mac" ;;
  Linux)                HOST_OS="linux" ;;
  MINGW*|MSYS*|CYGWIN*) HOST_OS="windows" ;;
  *)                    HOST_OS="unknown" ;;
esac

have() { command -v "$1" >/dev/null 2>&1; }

# rustup/cargo 는 보통 ~/.cargo/bin 에 설치되는데 비로그인 셸(CI, 갓 설치한 직후의 세션)에서는
# PATH 에 잡히지 않는다 — 그대로 두면 "Rust 없음"으로 오탐해 엉뚱한 안내를 낸다.
# build-tauri.sh 의 preflight 와 같은 보강을 여기서도 먼저 해둔다.
if [[ -d "$HOME/.cargo/bin" ]]; then
  case ":$PATH:" in
    *":$HOME/.cargo/bin:"*) ;;
    *) export PATH="$HOME/.cargo/bin:$PATH" ;;
  esac
fi

# 6장의 점검 결과("지금 막히진 않지만 결국 필요한 것")를 모아두는 버퍼. 항목마다 그때그때
# 출력하면 npm install 로그에 묻혀 무엇을 해야 할지 파악이 안 되므로 마지막에 한 번에 낸다.
ADVISORIES=()
advise() { ADVISORIES+=("$1"); }

print_advisories() {
  [ ${#ADVISORIES[@]} -eq 0 ] && return 0
  echo
  echo "───────────────────────────────────────────────────────────────────────"
  echo "ℹ 지금 당장 막히지는 않지만, 아래는 준비해두어야 합니다:"
  local a
  for a in "${ADVISORIES[@]}"; do
    echo
    echo "$a"
  done
  echo "───────────────────────────────────────────────────────────────────────"
}

# ── 1. Node.js 20+ / npm ────────────────────────────────────────────────────
if ! have node || ! have npm; then
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
  if ! have emcc && ! have docker; then
    echo "✗ emcc(Emscripten)도 docker도 없습니다. 둘 중 하나를 준비하세요:" >&2
    echo "   - Emscripten 설치: bash scripts/setup/setup-macos.sh (macOS) / bash scripts/setup/setup-wsl.sh (WSL2·Linux)" >&2
    echo "   - 또는 Docker 설치 (build-wasm.sh 가 emscripten/emsdk 이미지로 자동 빌드)" >&2
    exit 1
  fi
  # emcc 없이 Docker 폴백으로 가야 하는 상황이면 데몬이 실제로 떠 있는지까지 봐야 한다 —
  # CLI만 설치돼 있고 데몬이 죽어 있으면 build-wasm.sh 가 그때 가서 실패한다.
  if ! have emcc && ! docker info >/dev/null 2>&1; then
    echo "✗ emcc가 없어 Docker 폴백으로 빌드해야 하는데, Docker 데몬에 연결할 수 없습니다." >&2
    echo "   Docker Desktop/데몬을 실행한 뒤 다시 시도하거나, Emscripten을 직접 설치하세요:" >&2
    echo "   bash scripts/setup/setup-macos.sh (macOS) / bash scripts/setup/setup-wsl.sh (WSL2·Linux)" >&2
    exit 1
  fi
fi

# ── 4. 의존성 설치 ──────────────────────────────────────────────────────────
echo "→ npm install"
npm install

# ── 5. WASM 엔진 빌드 (native/wasm-engine/custom/*.c → public/wasm/) ────────
# 하드닝(FF_PROT_HARDEN=1, wasm-opt 스트립 + 상수 XOR 난독화 + 글루 JS 난독화)은 배포
# 빌드(build:desktop/build:tauri*)에서 자동으로 켜진다. 여기서 도는 단독 build:wasm 는
# 기본 꺼짐 — custom/*.c 를 반복 수정하는 동안 디버깅 편의를 유지하기 위해서다.
# --dev: build:wasm 기본값은 암호화 스테이징까지 수행하는데, 여기선 온보딩용 순수 컴파일만
# 필요하고 Tauri 키 파일(src-tauri/src/wasm_key.rs 등) 생성은 사이드이펙트로 원치 않는다.
if [ "$HAS_ENGINE_SRC" -eq 0 ]; then
  echo "→ npm run build:wasm -- --dev"
  npm run build:wasm -- --dev
else
  cat <<EOF

⚠ 엔진 C 소스가 없어 WASM 빌드를 건너뜁니다.
  이 저장소는 알고리즘 소스를 포함하지 않습니다($ENGINE_DIR/.gitignore).

  본인 .c/.h 를 아래 폴더에 넣고 다시 실행하세요(파일명 제약 없음):
      $ENGINE_DIR/custom/
      → 계약: ff_prot_init / ff_prot_set_param / ff_prot_start_exec(9-인자) /
        ff_prot_stop_exec 4개를 export (자세히: $ENGINE_DIR/custom/README.md)

      npm run bootstrap     # 또는 엔진만: npm run build:wasm -- --dev
EOF
fi

# ── 6. 데스크톱 셸(Tauri) 전제조건 점검 — 전부 비차단 ───────────────────────
# npm run dev(UI 확인 전용) 워크플로는 아래 어떤 항목도 필요로 하지 않는다 — 이 온보딩은
# 하나가 빠져도 절대 실패하지 않는다. 다만 오디오 캡처/재생을 실제로 테스트하려면 Tauri
# 데스크톱 셸이 유일한 경로라 결국 전부 필요해지므로, "안내문을 항상 뿌리는" 대신 실제로
# 있는지 확인해서 없는 것만 모아 마지막에 보여준다.

# 6-1. Rust 툴체인 — cargo 유무만 보면 부족하다. rustup 은 깔았지만 툴체인(stable)을 한 번도
#      설치하지 않아 `rustup install stable` 이 따로 필요한 상태가 실제로 흔하다(이 경우
#      rustup shim 때문에 cargo 가 PATH 에 있어도 실행하면 "no default toolchain" 으로 죽는다).
if ! have cargo && ! have rustup; then
  advise "$(cat <<'EOF'
  [Rust] 툴체인이 없습니다 — npm run dev(UI 확인 전용)에는 필요 없지만, 오디오 캡처/재생을
    테스트하려면 Tauri 데스크톱 셸(build:tauri*, tauri:preview)이 유일한
    경로라 결국 필요합니다.
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh    # https://rustup.rs
EOF
)"
elif have rustup && ! rustup show active-toolchain >/dev/null 2>&1; then
  advise "$(cat <<'EOF'
  [Rust] rustup 은 있지만 기본 툴체인이 설치되어 있지 않습니다 — 이 상태로 tauri build 를
    돌리면 "no default toolchain" 으로 중단됩니다.
        rustup install stable && rustup default stable
EOF
)"
fi

# 6-2. Linux/WSL — Tauri v2 는 WebKitGTK 개발 패키지에 링크한다. 종전에는 조건 없이 안내만
#      하던 항목이라, 실제로 깔렸는지 pkg-config 로 확인해 없을 때만 알린다.
if [[ "$HOST_OS" == "linux" ]]; then
  if ! have pkg-config || ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
    advise "$(cat <<'EOF'
  [Linux/WSL] Tauri v2 의 WebKitGTK 의존 패키지가 확인되지 않습니다 — tauri build/dev 가
    링크 단계에서 실패합니다.
        sudo apt install libwebkit2gtk-4.1-dev pkg-config libssl-dev \
          librsvg2-dev libxdo-dev libayatana-appindicator3-dev
EOF
)"
  fi
fi

# 6-3. macOS — build:tauri -- --mac 이 CoreAudio 헬퍼(mac.swift)를 swiftc 로 컴파일한다.
if [[ "$HOST_OS" == "mac" ]] && ! have swiftc; then
  advise "$(cat <<'EOF'
  [macOS] Xcode Command Line Tools(swiftc)가 없습니다 — build:tauri -- --mac 이 CoreAudio 네이티브
    헬퍼(native/macos/audio-device-helper)를 컴파일하지 못해 실패합니다.
        xcode-select --install
EOF
)"
fi

# 6-4. Windows 크로스 패키징(WSL/Linux 호스트에서 build:tauri -- --windows) 전제조건.
#      예전에는 여기서 감지만 하고 안내문만 냈고, 실제 설치는 build-tauri.sh 의 preflight 가
#      "빌드를 시작한 뒤"에 했다. 그래서 온보딩을 다 끝낸 사람이 첫 --windows 빌드에서 다시
#      수 분짜리 cargo install 을 기다리는 흐름이 됐다. 이제 bootstrap 단계에서 미리 끝낸다.
#
#      자동 설치 대상은 sudo 가 필요 없는 rustup/cargo 계열뿐이다(build-tauri.sh 와 동일 정책).
#      apt 계열은 sudo 를 조용히 부르지 않기 위해 기본은 안내만 하고, BOOTSTRAP_APT_INSTALL=1
#      일 때만 실제로 설치한다.
#        BOOTSTRAP_NO_AUTO_INSTALL=1 (또는 TAURI_NO_AUTO_INSTALL=1) → 전부 안내만
if [[ "$HOST_OS" == "linux" ]] && (have rustup || have cargo); then
  WIN_AUTO_INSTALL=true
  if [[ -n "${BOOTSTRAP_NO_AUTO_INSTALL:-}" || "${TAURI_NO_AUTO_INSTALL:-}" == "1" ]]; then
    WIN_AUTO_INSTALL=false
  fi

  # ① rustup 계열 — Windows MSVC 타깃과 cargo-xwin 러너. 자동 설치 가능.
  WIN_CROSS_MISSING=()
  if have rustup; then
    if ! rustup show active-toolchain >/dev/null 2>&1; then
      if $WIN_AUTO_INSTALL; then
        echo "→ [Windows 크로스] 기본 Rust 툴체인 설치 (rustup install stable — 수 분 소요)"
        rustup install stable && rustup default stable \
          || WIN_CROSS_MISSING+=("rustup install stable && rustup default stable")
      else
        WIN_CROSS_MISSING+=("rustup install stable && rustup default stable")
      fi
    fi
    if ! rustup target list --installed 2>/dev/null | grep -qx "x86_64-pc-windows-msvc"; then
      if $WIN_AUTO_INSTALL; then
        echo "→ [Windows 크로스] rustup target add x86_64-pc-windows-msvc"
        rustup target add x86_64-pc-windows-msvc \
          || WIN_CROSS_MISSING+=("rustup target add x86_64-pc-windows-msvc")
      else
        WIN_CROSS_MISSING+=("rustup target add x86_64-pc-windows-msvc")
      fi
    fi
  fi
  if ! have cargo-xwin; then
    if $WIN_AUTO_INSTALL && have cargo; then
      echo "→ [Windows 크로스] cargo install cargo-xwin (컴파일에 수 분 소요)"
      # 실패해도 온보딩 전체를 죽이지 않는다 — 6장은 비차단이 원칙이고, 여기서 못 깔면
      # build-tauri.sh 의 preflight 가 빌드 시작 전에 다시 시도한다.
      # 설치 성공 여부와 PATH 노출 여부를 한 번에 판정해야 안내가 중복되지 않는다.
      if ! { cargo install cargo-xwin && have cargo-xwin; }; then
        WIN_CROSS_MISSING+=("cargo install cargo-xwin")
      fi
    else
      WIN_CROSS_MISSING+=("cargo install cargo-xwin")
    fi
  fi

  # ② apt 계열(sudo 필요) — 링커/코드젠 도구, NSIS 인스톨러, ASIO 헬퍼용 mingw 크로스 컴파일러.
  WIN_APT_MISSING=()
  { have clang && have lld; } || WIN_APT_MISSING+=("clang" "lld" "llvm")
  have makensis              || WIN_APT_MISSING+=("nsis")
  have x86_64-w64-mingw32-g++ || WIN_APT_MISSING+=("g++-mingw-w64-x86-64")
  if [ ${#WIN_APT_MISSING[@]} -gt 0 ]; then
    if [[ -n "${BOOTSTRAP_APT_INSTALL:-}" ]] && have apt-get; then
      echo "→ [Windows 크로스] sudo apt install ${WIN_APT_MISSING[*]}"
      if sudo apt-get install -y "${WIN_APT_MISSING[@]}"; then
        WIN_APT_MISSING=()
      else
        echo "  ⚠ apt 설치가 실패했습니다 — 아래 명령을 직접 실행하세요." >&2
      fi
    fi
    if [ ${#WIN_APT_MISSING[@]} -gt 0 ]; then
      WIN_CROSS_MISSING+=("sudo apt install ${WIN_APT_MISSING[*]}")
    fi
  fi

  if [ ${#WIN_CROSS_MISSING[@]} -gt 0 ]; then
    advise "$(printf '%s\n' \
      "  [Windows 크로스] WSL/Linux 에서 build:tauri -- --windows 를 돌리려면 아래가 더 필요합니다" \
      "    (실험적 경로 — README 참고. sudo 가 필요한 apt 항목은 BOOTSTRAP_APT_INSTALL=1 을" \
      "     붙이면 bootstrap 이 직접 설치합니다):" \
      "${WIN_CROSS_MISSING[@]/#/        }")"
  fi
fi

# 6-5. wasm-tools — 배포 하드닝 빌드의 구조 변형(wasm-mutate) 단계에만 쓰인다. 없으면 그
#      단계만 비파괴적으로 건너뛰므로 빌드 자체는 성공한다.
if ! have wasm-tools; then
  advise "$(cat <<'EOF'
  [선택] wasm-tools 가 없습니다 — 배포 하드닝 빌드에서 구조 변형(wasm-mutate) 단계만 조용히
    건너뜁니다. 상수 난독화·스트립은 그대로 적용되며 빌드는 실패하지 않습니다.
        cargo install wasm-tools
EOF
)"
fi

# 6-6. Java — build:desktop / build:tauri* 는 FF_PROT_HARDEN=1 로 emcc 를 돌리는데, 그 안의
#      --closure 1(Closure Compiler)이 Java 런타임을 요구한다(build-wasm.sh 참고).
#      Docker(emscripten/emsdk) 폴백으로 빌드하면 이미지에 Java 가 들어 있어 무관하므로,
#      "로컬 emcc 는 있는데(=Docker 폴백이 아님) Java 가 없는" 조합일 때만 알린다.
if have emcc && ! have java; then
  advise "$(cat <<'EOF'
  [필요] Java 가 없습니다 — 배포 하드닝 빌드(build:desktop / build:tauri*)가 로컬 emcc 로 글루
    JS 를 압축하는 --closure 1 단계에서 Java 런타임을 필요로 합니다(방금 실행한 단독
    build:wasm 는 하드닝이 꺼져 있어 영향 없음).
        macOS:      brew install openjdk    (설치 후 안내되는 PATH/symlink 지시 따르기)
        Debian/WSL: sudo apt install default-jre
    Java 대신 Docker 로 빌드하면 emscripten/emsdk 이미지에 포함돼 있어 별도 설치가 필요 없습니다.
EOF
)"
fi

# 6-7. ASIO SDK — Windows 네이티브 헬퍼(build-win.sh) 컴파일에만 필요하다. 재배포 제약이
#      있어 저장소에 없으므로, Windows 패키징을 할 수 있는 호스트에서만 존재를 확인한다.
if [[ "$HOST_OS" == "linux" || "$HOST_OS" == "windows" ]]; then
  ASIO_DIR="${ASIOSDK_DIR:-native/windows/audio-device-helper/third_party/ASIOSDK}"
  if [ ! -d "$ASIO_DIR" ]; then
    advise "$(cat <<EOF
  [Windows 패키징] ASIO SDK 가 없습니다($ASIO_DIR) — build:tauri -- --windows 가 ASIO 헬퍼
    컴파일 단계에서 실패합니다(낡은 exe 를 조용히 패키징하지 않기 위한 의도적 동작).
    재배포 제약으로 저장소에 포함하지 않습니다 — Teams 에 공유된 SDK 를 위 경로에 두거나
    ASIOSDK_DIR=<경로> 로 지정하세요. 툴체인 없이 커밋된 exe 를 그대로 쓰려면:
        SKIP_WIN_HELPER_BUILD=1 npm run build:tauri -- --windows
EOF
)"
  fi
fi

# ── 7. 엔진 소스가 없으면 여기서 종료 ───────────────────────────────────────
if [ "$HAS_ENGINE_SRC" -ne 0 ]; then
  print_advisories
  echo
  echo "✓ 의존성 설치 완료 — 엔진 소스를 넣은 뒤 다시 실행하세요 (위 안내 참고)."
  echo "  UI만 먼저 보려면: npm run dev   (분석은 동작하지 않습니다 — 엔진 없음)"
  exit 0
fi

# ── 8. dev 서버 스모크 테스트 ───────────────────────────────────────────────
# 예전에는 여기서 `exec npm run dev` 로 서버를 띄운 채 그대로 넘겨줬는데, 온보딩 스크립트가
# 끝나지 않고 붙잡혀 있어(Ctrl+C 를 눌러야 종료) 뒤에 안내를 붙일 수도, 자동화에서 호출할
# 수도 없었다. 이제는 백그라운드로 띄워 실제 HTTP 응답까지 확인한 뒤 즉시 정리한다.
DEV_PID=""
DEV_LOG=""

stop_dev_server() {
  [ -z "$DEV_PID" ] && return 0
  # set -m 으로 띄웠으므로 DEV_PID 는 프로세스 그룹 리더다 — 그룹째 종료해야 npm 이 자식으로
  # 띄운 next dev 가 포트를 쥔 채 고아로 남지 않는다.
  kill -TERM "-$DEV_PID" 2>/dev/null || kill -TERM "$DEV_PID" 2>/dev/null || true
  local i
  for i in 1 2 3 4 5; do
    kill -0 "$DEV_PID" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$DEV_PID" 2>/dev/null; then
    kill -KILL "-$DEV_PID" 2>/dev/null || kill -KILL "$DEV_PID" 2>/dev/null || true
  fi
  wait "$DEV_PID" 2>/dev/null || true
  DEV_PID=""
}
cleanup() {
  stop_dev_server
  if [ -n "$DEV_LOG" ]; then rm -f "$DEV_LOG"; fi
}
trap cleanup EXIT INT TERM

if [ -n "${BOOTSTRAP_NO_DEV:-}" ]; then
  print_advisories
  cat <<'EOF'

✓ 준비 완료 (BOOTSTRAP_NO_DEV=1 — dev 서버 확인은 건너뜀).

  npm run dev            UI 확인 전용 — 브라우저에는 window.audioDevice/audioCapture
                         브리지가 없어 오디오 캡처·재생은 동작하지 않습니다.

  실제 캡처/재생까지 확인하려면 (Tauri 셸이 유일한 경로):
  npm run build:desktop && npm run tauri:preview    # Rust/IPC 변경까지 반영
  npm run build:tauri -- --mac                      # 패키징 (→ dist-tauri/mac/)
EOF
  exit 0
fi

# 3000 번이 이미 쓰이고 있으면 next dev 가 다음 포트로 옮겨 뜬다 — 고정 포트로 확인하지 않고
# 로그가 실제로 출력한 URL 을 파싱해 그 주소로 확인한다.
http_ok() {
  node -e '
    const http = require("http");
    const req = http.get(process.argv[1], (res) => {
      res.resume();
      process.exit(res.statusCode && res.statusCode < 500 ? 0 : 1);
    });
    req.on("error", () => process.exit(1));
    req.setTimeout(3000, () => { req.destroy(); process.exit(1); });
  ' "$1" >/dev/null 2>&1
}

DEV_TIMEOUT="${BOOTSTRAP_DEV_TIMEOUT:-90}"
DEV_LOG="$(mktemp "${TMPDIR:-/tmp}/iron-bootstrap-dev.XXXXXX")"

echo
echo "→ dev 서버 기동 확인 중 (최대 ${DEV_TIMEOUT}초 — 응답이 확인되면 자동으로 종료합니다)"

set -m   # job control 활성화 → npm 이 자체 프로세스 그룹 리더가 되어 그룹째 정리할 수 있다
npm run dev >"$DEV_LOG" 2>&1 &
DEV_PID=$!
set +m

DEV_URL=""
waited=0
while [ "$waited" -lt "$DEV_TIMEOUT" ]; do
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    echo "✗ dev 서버가 기동 도중 종료됐습니다. 마지막 로그:" >&2
    tail -n 30 "$DEV_LOG" >&2
    DEV_PID=""
    exit 1
  fi
  candidate="$(grep -Eo 'http://(localhost|127\.0\.0\.1):[0-9]+' "$DEV_LOG" | head -n 1 || true)"
  if [ -n "$candidate" ] && http_ok "$candidate"; then
    DEV_URL="$candidate"
    break
  fi
  sleep 1
  waited=$((waited + 1))
done

if [ -z "$DEV_URL" ]; then
  echo "✗ ${DEV_TIMEOUT}초 안에 dev 서버 응답을 확인하지 못했습니다. 마지막 로그:" >&2
  tail -n 30 "$DEV_LOG" >&2
  echo "  (느린 머신이면 BOOTSTRAP_DEV_TIMEOUT=180 npm run bootstrap 으로 늘려보세요)" >&2
  exit 1
fi

echo "✓ dev 서버 정상 기동 확인: $DEV_URL"
stop_dev_server
echo "✓ 확인을 마치고 dev 서버를 종료했습니다."

print_advisories

cat <<'EOF'

✓ 준비 완료.

  npm run dev            UI 확인 전용 — 브라우저에는 window.audioDevice/audioCapture
                         브리지가 없어 오디오 캡처·재생은 동작하지 않습니다.

  실제 캡처/재생까지 확인하려면 (Tauri 셸이 유일한 경로):
  npm run build:desktop && npm run tauri:preview    # Rust/IPC 변경까지 반영
  npm run build:tauri -- --mac                      # 패키징 (→ dist-tauri/mac/)
EOF
