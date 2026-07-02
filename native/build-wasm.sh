#!/usr/bin/env bash
# build-wasm.sh — ff_prot.c 를 WASM(Node 타깃, 단일 파일)으로 컴파일한다.
#
#   ./build-wasm.sh      # wasm/ff_prot.js 생성 (wasm 바이너리 base64 내장)
#
# 요구: emcc(Emscripten). 산출물은 src/features/audio/lib/wasm-engine.ts 가
#       require()로 로드해 서버(Node) 프로세스 안에서 ff_prot_* 를 직접 호출한다.
# libirontune.so(koffi FFI, ELF x86-64 전용)와 달리 아키텍처 무관 — QEMU 불필요.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p wasm

emcc ff_prot.c -O3 -o wasm/ff_prot.js \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=FfProtModule \
  -sEXPORTED_FUNCTIONS=_ff_prot_init,_ff_prot_set_param,_ff_prot_start_exec,_ff_prot_stop_exec,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAP16,HEAP32 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sENVIRONMENT=node \
  -sSINGLE_FILE=1

echo "✓ 빌드 완료: wasm/ff_prot.js (단일 파일, wasm 바이너리 내장)"
ls -la wasm/ff_prot.js
