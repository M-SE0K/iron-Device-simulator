#!/usr/bin/env bash
# build-wasm.sh — ff_prot.c 를 브라우저 타깃 WASM으로 컴파일한다.
#
#   ./build-wasm.sh      # ../../public/wasm/ff_prot.{js,wasm} 생성 (repo root 기준 public/wasm/)
#
# 요구: emcc(Emscripten) — 없으면 Docker(emscripten/emsdk 이미지)로 자동 폴백 (아래 참고).
#   src/features/audio/lib/engine/adapters/wasm-client.ts 가 브라우저/Tauri WebView
#   안에서 fetch 로 로드해 서버 없이 직접 호출한다.
# libirontune.so(koffi FFI, ELF x86-64 전용)와 달리 아키텍처 무관 — QEMU 불필요.
#
# 이 폴더(native/wasm-engine/)는 프로젝트 최상위 native/ 밑에 있고 특정 데스크톱 셸에
# 종속되지 않는다 — 산출물(public/wasm/ff_prot.{js,wasm})은 웹 전용 빌드(build:desktop)에도
# 그대로 쓰인다.
#
# 실험(debug) 빌드 — ff_prot.c의 FF_PROT_DEBUG_VI 가드 블록(V/I 값 printf 덤프)을 켠다.
# 이 덤프는 프레임마다 대량 console 출력을 일으켜 N1(네이티브 IPC 릴레이) 등 E2E 지연
# 측정을 오염시키므로, 클린 빌드(public/wasm/, 기본)와 물리적으로 분리된 출력 경로에 둔다:
#   npm run wasm:build:debug   # FF_PROT_DEBUG_VI=1 WASM_OUT_DIR=../../public/wasm-debug
set -euo pipefail
cd "$(dirname "$0")"

WASM_OUT_DIR="${WASM_OUT_DIR:-../../public/wasm}"
mkdir -p "$WASM_OUT_DIR"

# ── emcc 확인 — 로컬에 없으면 Docker(emscripten/emsdk) 폴백 ─────────────────
# 알고리즘만 갈아끼우려는 사용자가 Emscripten SDK를 설치하지 않고도 빌드할 수 있게,
# 로컬 emcc 부재 시 공식 emscripten/emsdk 이미지로 같은 커맨드를 실행한다.
# (repo 루트를 /src로 마운트 — 산출물 경로(../../public/wasm)가 컨테이너 안에서도 유효)
if command -v emcc >/dev/null 2>&1; then
  EMCC=(emcc)
elif command -v docker >/dev/null 2>&1; then
  REPO_ROOT="$(cd ../.. && pwd)"
  echo "→ 로컬 emcc 없음 — Docker(emscripten/emsdk)로 폴백 (최초 1회는 이미지 다운로드로 오래 걸릴 수 있음)"
  EMCC=(docker run --rm -u "$(id -u):$(id -g)" \
    -v "$REPO_ROOT":/src -w /src/native/wasm-engine \
    emscripten/emsdk emcc)
else
  echo "✗ emcc(Emscripten)도 docker도 없습니다. 둘 중 하나를 준비하세요:" >&2
  echo "   - Emscripten 설치: bash scripts/setup/setup-macos.sh (macOS) / bash scripts/setup/setup-wsl.sh (WSL2·Linux)" >&2
  echo "   - 또는 Docker 설치 (이 스크립트가 emscripten/emsdk 이미지로 자동 빌드)" >&2
  exit 1
fi

EMCC_DEFINES=()
if [[ "${FF_PROT_DEBUG_VI:-}" == "1" ]]; then
  EMCC_DEFINES+=("-DFF_PROT_DEBUG_VI=1")
  echo "→ 실험(debug) 빌드: FF_PROT_DEBUG_VI=1 (V/I 값 printf 덤프 포함, 출력: $WASM_OUT_DIR)"
fi
if [[ "${FF_PROT_DUMMY_ATTENUATION:-}" == "1" ]]; then
  EMCC_DEFINES+=("-DFF_PROT_DUMMY_ATTENUATION=1")
  echo "→ 더미 감쇠 빌드: FF_PROT_DUMMY_ATTENUATION=1 (pass B 감쇠 항상 미개입, 출력: $WASM_OUT_DIR)"
fi

# ── 컴파일 대상 소스 결정 ────────────────────────────────────────────────────
# 우선순위: ① FF_PROT_SRCS 명시 → ② custom/*.c (사용자 드롭인) → ③ 폴더 내 *.c (스텁).
#
# ② custom/ 은 "본인 알고리즘 갈아끼우기" 전용 폴더다 — 파일명 제약 없이 .c/.h 를 넣으면
#   스텁(ff_prot.c 등)은 자동으로 빌드에서 빠지므로, 스텁을 지우거나 덮어쓸 필요가 없다
#   (= git pull 시 업스트림 스텁 갱신과 충돌하지 않는다). 단 export 심볼(ff_prot_* 4개,
#   ff_prot.h 계약)은 유지해야 한다 — 함수명이 다르면 래퍼 .c 로 매핑 (custom/README.md).
# ③ 정품 소스는 단일 파일이 아니라 다중 모듈(sm_power_meter/biquad_filter/drc_func 등)일
#   수 있어, selftest 계열(자체 main 보유)을 뺀 모든 *.c 를 컴파일한다.
# 특정 파일만 골라 빌드하려면: FF_PROT_SRCS="a.c b.c" ./build-wasm.sh
shopt -s nullglob
if [[ -n "${FF_PROT_SRCS:-}" ]]; then
  read -r -a SRCS <<< "$FF_PROT_SRCS"
else
  SRCS=()
  for f in custom/*.c; do
    [[ "$f" == *selftest* ]] && continue
    SRCS+=("$f")
  done
  if [[ ${#SRCS[@]} -gt 0 ]]; then
    echo "→ custom/ 사용자 소스 감지 — 스텁 대신 custom/*.c 만 빌드합니다"
  else
    for f in *.c; do
      [[ "$f" == *selftest* ]] && continue   # 순수 C 셀프테스트(main 보유) 제외
      SRCS+=("$f")
    done
  fi
fi
shopt -u nullglob
if [[ ${#SRCS[@]} -eq 0 ]]; then
  echo "✗ 컴파일할 .c 소스가 없습니다 (native/wasm-engine/)." >&2
  exit 1
fi
echo "→ 컴파일 대상: ${SRCS[*]}"

# ── 하드닝(FF_PROT_HARDEN=1) — 방법 1(소스 난독화, 있으면)+2(빌드 플래그) ──────────────
# 배포용 빌드(scripts/build/build-static-local.sh)는 기본으로 이 플래그를 켠다.
# npm run wasm:build 단독 실행(custom/*.c 반복 수정 중)은 기본 꺼짐 — 디버깅 편의 유지.
HARDEN_FLAGS=()
if [[ "${FF_PROT_HARDEN:-}" == "1" ]]; then
  echo "→ 하드닝 빌드: FF_PROT_HARDEN=1"
  SRCS_OBF=()
  while IFS= read -r line; do
    SRCS_OBF+=("$line")
  done < <(./obfuscate-source.sh "${SRCS[@]}")
  SRCS=("${SRCS_OBF[@]}")
  # -flto: 링크타임 최적화로 함수 경계를 흐린다. -g0: 디버그 정보 명시적 배제.
  # --closure 1: Closure Compiler로 글루 JS(ff_prot.js) 식별자/구조 압축(Java 필요 —
  # Docker(emscripten/emsdk) 폴백에는 이미 포함되어 있다).
  HARDEN_FLAGS+=(-flto -g0 --closure 1)
fi

# 내보내는 함수 목록도 정품 API 확장(예: _ff_prot_end, _sm_power_meter_*) 시 여기에 추가한다.
"${EMCC[@]}" "${SRCS[@]}" ${EMCC_DEFINES[@]+"${EMCC_DEFINES[@]}"} ${HARDEN_FLAGS[@]+"${HARDEN_FLAGS[@]}"} -I. -O3 -o "$WASM_OUT_DIR/ff_prot.js" \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=FfProtModule \
  -sEXPORTED_FUNCTIONS=_ff_prot_init,_ff_prot_set_param,_ff_prot_start_exec,_ff_prot_stop_exec,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAP16,HEAP32 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sENVIRONMENT=web \
  -sEXPORT_ES6=0

echo "✓ 브라우저 빌드 완료: $WASM_OUT_DIR/ff_prot.js + ff_prot.wasm"
ls -la "$WASM_OUT_DIR/ff_prot.js" "$WASM_OUT_DIR/ff_prot.wasm"

# ── 하드닝(FF_PROT_HARDEN=1) — 방법 3(바이너리 스트립)+4(글루 JS 난독화)+5.5(상수 난독화) ──
if [[ "${FF_PROT_HARDEN:-}" == "1" ]]; then
  echo "→ wasm-opt 스트립/재최적화..."
  # --all-features: emcc -O3 산출물이 쓰는 확장(nontrapping-fptoint 등)을 wasm-opt가 모르는
  # 채로 거부(validator error)하지 않도록 전체 허용. 실제로 안 쓰는 feature는 무해하게 무시된다.
  npx --yes wasm-opt "$WASM_OUT_DIR/ff_prot.wasm" -O3 --all-features \
    --strip-debug --strip-producers --strip-target-features \
    -o "$WASM_OUT_DIR/ff_prot.wasm"

  echo "→ 모델링 상수 난독화 (obfuscate-wasm-consts.js)..."
  # C 소스(custom/*.c)는 건드리지 않는다 — 컴파일이 끝난 .wasm 산출물만 후처리해서
  # f64.const/f32.const 리터럴을 mask+masked-value XOR 쌍으로 바꿔치기한다. 소스 소유권이
  # 없는 사용자가 custom/에 자기 알고리즘을 드롭인해도 값 이름/의미를 몰라도 자동 적용된다.
  # 반드시 이 단계 이후로는 .wasm에 어떤 최적화 패스도 돌리지 않는다 — 그러면 XOR 패턴이
  # 상수 폴딩으로 원래 리터럴로 되돌아가 난독화가 무력화된다(아래 글루 JS 난독화는 .js만
  # 건드리므로 순서 무관).
  node obfuscate-wasm-consts.js "$WASM_OUT_DIR/ff_prot.wasm"

  echo "→ 글루 JS 난독화..."
  # --rename-globals false 필수: MODULARIZE 글루가 노출하는 전역 FfProtModule 을
  # wasm-client.ts(loadFactory())가 이름으로 직접 읽는다 — 리네임하면 로더가 깨진다.
  # --self-defending false 필수: self-defending 코드는 이후 재포매팅/재압축에 취약해 깨지기 쉽다.
  npx --yes javascript-obfuscator "$WASM_OUT_DIR/ff_prot.js" \
    --output "$WASM_OUT_DIR/ff_prot.js" \
    --compact true \
    --control-flow-flattening true --control-flow-flattening-threshold 0.5 \
    --string-array true --string-array-encoding base64 \
    --rename-globals false --self-defending false

  echo "✓ 하드닝 완료: $WASM_OUT_DIR/ff_prot.js + ff_prot.wasm"
fi
