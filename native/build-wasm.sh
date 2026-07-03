#!/usr/bin/env bash
# build-wasm.sh — ff_prot.c 를 WASM으로 컴파일한다 (Node 타깃 + 브라우저 타깃).
#
#   ./build-wasm.sh      # wasm/ff_prot.js (서버용) + ../public/wasm/ff_prot.{js,wasm} (클라이언트용) 생성
#
# 요구: emcc(Emscripten).
#   - Node 타깃(wasm/ff_prot.js, 단일 파일): src/features/audio/lib/wasm-engine.ts 가
#     require()로 로드해 서버(Node) 프로세스 안에서 ff_prot_* 를 직접 호출한다.
#   - 브라우저 타깃(public/wasm/ff_prot.{js,wasm}): src/features/audio/lib/wasm-client-engine.ts 가
#     브라우저(및 Capacitor WebView) 안에서 fetch 로 로드해 서버 없이 직접 호출한다
#     (모바일 앱 패키징용 — WS/서버 의존 없음).
# libirontune.so(koffi FFI, ELF x86-64 전용)와 달리 아키텍처 무관 — QEMU 불필요.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p wasm ../public/wasm

# ── Node 타깃 (서버 엔진용, 단일 파일) ────────────────────────────────────────
emcc ff_prot.c -O3 -o wasm/ff_prot.js \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=FfProtModule \
  -sEXPORTED_FUNCTIONS=_ff_prot_init,_ff_prot_set_param,_ff_prot_start_exec,_ff_prot_stop_exec,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAP16,HEAP32 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sENVIRONMENT=node \
  -sSINGLE_FILE=1

echo "✓ 서버(Node) 빌드 완료: wasm/ff_prot.js (단일 파일, wasm 바이너리 내장)"

# ── 브라우저 타깃 (클라이언트/모바일 엔진용) ──────────────────────────────────
emcc ff_prot.c -O3 -o ../public/wasm/ff_prot.js \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=FfProtModule \
  -sEXPORTED_FUNCTIONS=_ff_prot_init,_ff_prot_set_param,_ff_prot_start_exec,_ff_prot_stop_exec,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAP16,HEAP32 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sENVIRONMENT=web \
  -sEXPORT_ES6=0

echo "✓ 브라우저 빌드 완료: ../public/wasm/ff_prot.js + ff_prot.wasm"
ls -la wasm/ff_prot.js ../public/wasm/ff_prot.js ../public/wasm/ff_prot.wasm
