#!/usr/bin/env bash
# build-wasm.sh — ff_prot.c 를 브라우저 타깃 WASM으로 컴파일한다.
#
#   ./build-wasm.sh      # ../../../public/wasm/ff_prot.{js,wasm} 생성 (repo root 기준 public/wasm/)
#
# 요구: emcc(Emscripten).
#   src/features/audio/lib/engine/adapters/wasm-client.ts 가 브라우저/Electron 렌더러
#   안에서 fetch 로 로드해 서버 없이 직접 호출한다.
# libirontune.so(koffi FFI, ELF x86-64 전용)와 달리 아키텍처 무관 — QEMU 불필요.
#
# 이 폴더(electron/native/wasm-engine/)는 electron/ 밑에 있지만 Electron 전용이 아니다 —
# 산출물(public/wasm/ff_prot.{js,wasm})은 웹 전용 빌드(build:desktop)에도 그대로 쓰인다.
#
# 실험(debug) 빌드 — ff_prot.c의 FF_PROT_DEBUG_VI 가드 블록(V/I 값 printf 덤프)을 켠다.
# 이 덤프는 프레임마다 대량 console 출력을 일으켜 N1(네이티브 IPC 릴레이) 등 E2E 지연
# 측정을 오염시키므로, 클린 빌드(public/wasm/, 기본)와 물리적으로 분리된 출력 경로에 둔다:
#   npm run wasm:build:debug   # FF_PROT_DEBUG_VI=1 WASM_OUT_DIR=../../../public/wasm-debug
set -euo pipefail
cd "$(dirname "$0")"

WASM_OUT_DIR="${WASM_OUT_DIR:-../../../public/wasm}"
mkdir -p "$WASM_OUT_DIR"

EMCC_DEFINES=()
if [[ "${FF_PROT_DEBUG_VI:-}" == "1" ]]; then
  EMCC_DEFINES+=("-DFF_PROT_DEBUG_VI=1")
  echo "→ 실험(debug) 빌드: FF_PROT_DEBUG_VI=1 (V/I 값 printf 덤프 포함, 출력: $WASM_OUT_DIR)"
fi

# ── 컴파일 대상 소스 결정 ────────────────────────────────────────────────────
# 정품 소스는 단일 파일이 아니라 다중 모듈(sm_power_meter/biquad_filter/drc_func 등,
# VENDOR-API-SPEC.md 2.1)일 수 있다. 벤더 소스를 이 폴더에 드롭인하면 편집 없이 그대로
# 빌드되도록, selftest 계열(자체 main 보유)을 뺀 모든 *.c 를 컴파일한다.
# 특정 파일만 골라 빌드하려면: FF_PROT_SRCS="a.c b.c" ./build-wasm.sh
if [[ -n "${FF_PROT_SRCS:-}" ]]; then
  read -r -a SRCS <<< "$FF_PROT_SRCS"
else
  SRCS=()
  for f in *.c; do
    [[ "$f" == *selftest* ]] && continue   # 순수 C 셀프테스트(main 보유) 제외
    SRCS+=("$f")
  done
fi
if [[ ${#SRCS[@]} -eq 0 ]]; then
  echo "✗ 컴파일할 .c 소스가 없습니다 (electron/native/wasm-engine/)." >&2
  exit 1
fi
echo "→ 컴파일 대상: ${SRCS[*]}"

# 내보내는 함수 목록도 정품 API 확장(예: _ff_prot_end, _sm_power_meter_*) 시 여기에 추가한다.
emcc "${SRCS[@]}" "${EMCC_DEFINES[@]}" -O3 -o "$WASM_OUT_DIR/ff_prot.js" \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=FfProtModule \
  -sEXPORTED_FUNCTIONS=_ff_prot_init,_ff_prot_set_param,_ff_prot_start_exec,_ff_prot_stop_exec,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAP16,HEAP32 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sENVIRONMENT=web \
  -sEXPORT_ES6=0

echo "✓ 브라우저 빌드 완료: $WASM_OUT_DIR/ff_prot.js + ff_prot.wasm"
ls -la "$WASM_OUT_DIR/ff_prot.js" "$WASM_OUT_DIR/ff_prot.wasm"
