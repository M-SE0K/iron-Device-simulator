#!/usr/bin/env bash
# build-pcm-kit.sh — pcm_kit.c 를 독립(standalone) WASM으로 컴파일한다.
#
#   ./build-pcm-kit.sh   # ../../public/wasm/pcm_kit.wasm 생성
#
# ff_prot(보호 엔진) 빌드와 분리된 이유는 pcm_kit.c 헤더 주석 참고 — 이 산출물은
# 평문 배포 대상이라 wasm-encryption 스테이징(ff_prot.wasm 전용)의 영향을 받지 않고,
# 하드닝(FF_PROT_HARDEN)도 적용하지 않는다.
#
# 요구: emcc(Emscripten) — 없으면 Docker(emscripten/emsdk 이미지)로 자동 폴백
# (native/wasm-engine/build-wasm.sh 와 동일 정책).
#
# 산출물은 Emscripten 글루 JS 없는 순수 .wasm 이다(--no-entry). 로더
# (src/features/audio/lib/pcm-kit.ts)가 fetch + WebAssembly.instantiate 로 직접 띄우고,
# 로드 실패 시(파일 없음/SIMD 미지원 등) 동일 산식 JS 폴백으로 동작한다 — 이 빌드가
# 없어도 앱은 느릴 뿐 깨지지 않는다.
set -euo pipefail
cd "$(dirname "$0")"

WASM_OUT_DIR="${WASM_OUT_DIR:-../../public/wasm}"
mkdir -p "$WASM_OUT_DIR"

if command -v emcc >/dev/null 2>&1; then
  EMCC=(emcc)
elif command -v docker >/dev/null 2>&1; then
  REPO_ROOT="$(cd ../.. && pwd)"
  echo "→ 로컬 emcc 없음 — Docker(emscripten/emsdk)로 폴백"
  EMCC=(docker run --rm -u "$(id -u):$(id -g)" \
    -v "$REPO_ROOT":/src -w /src/native/pcm-kit \
    emscripten/emsdk emcc)
else
  echo "✗ emcc(Emscripten)도 docker도 없습니다 — native/wasm-engine/build-wasm.sh 안내 참고" >&2
  exit 1
fi

# -msimd128: 내부 루프(min/max/제곱합 리덕션) LLVM 자동 벡터화 — WKWebView(macOS 13.3+)/
# WebView2 모두 SIMD128 지원, 미지원 환경은 instantiate 실패 → 로더가 JS 폴백.
"${EMCC[@]}" pcm_kit.c -O3 -msimd128 --no-entry \
  -sEXPORTED_FUNCTIONS=_pcmkit_envelope,_pcmkit_in,_pcmkit_min,_pcmkit_max,_pcmkit_stats,_pcmkit_in_cap,_pcmkit_out_cap \
  -o "$WASM_OUT_DIR/pcm_kit.wasm"

echo "✓ pcm-kit 빌드 완료: $WASM_OUT_DIR/pcm_kit.wasm"
ls -la "$WASM_OUT_DIR/pcm_kit.wasm"
