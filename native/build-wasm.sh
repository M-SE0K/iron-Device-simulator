#!/usr/bin/env bash
# build-wasm.sh — ff_prot.c 를 브라우저 타깃 WASM으로 컴파일한다.
#
#   ./build-wasm.sh      # ../public/wasm/ff_prot.{js,wasm} 생성
#
# 요구: emcc(Emscripten).
#   src/features/audio/lib/engine/adapters/wasm-client.ts 가 브라우저(및 Capacitor
#   WebView) 안에서 fetch 로 로드해 서버 없이 직접 호출한다.
# libirontune.so(koffi FFI, ELF x86-64 전용)와 달리 아키텍처 무관 — QEMU 불필요.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p ../public/wasm

emcc ff_prot.c -O3 -o ../public/wasm/ff_prot.js \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=FfProtModule \
  -sEXPORTED_FUNCTIONS=_ff_prot_init,_ff_prot_set_param,_ff_prot_start_exec,_ff_prot_stop_exec,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAP16,HEAP32 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sENVIRONMENT=web \
  -sEXPORT_ES6=0

echo "✓ 브라우저 빌드 완료: ../public/wasm/ff_prot.js + ff_prot.wasm"
ls -la ../public/wasm/ff_prot.js ../public/wasm/ff_prot.wasm
