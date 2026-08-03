#!/usr/bin/env bash
# obfuscate-source.sh — custom/*.c 를 Tigress(C 소스 난독화기)로 변환한다.
#
#   ./obfuscate-source.sh <src1.c> [src2.c ...]
#
# 표준출력으로 "빌드에 실제로 넘겨야 할 소스 경로 목록"을 한 줄에 하나씩 출력한다.
# build-wasm.sh가 이 출력을 그대로 SRCS 로 치환해 emcc에 넘긴다.
#
# tigress(https://tigress.wtf) 바이너리가 PATH에 없으면 아무 변환도 하지 않고
# 입력 경로를 그대로 돌려준다 — 대부분의 dev 머신엔 설치되어 있지 않으므로, 이 훅이
# 없다고 FF_PROT_HARDEN=1 빌드 자체가 깨지면 안 된다(방법 2~4 하드닝은 그대로 진행).
#
# 지금 이 리포의 native/wasm-engine/custom/ff_prot.c 는 참조 스텁(정품 아님, README 참고)
# 이라 실제로 지킬 비밀이 없다 — 이 훅은 정품 vendor 알고리즘이 custom/ 에 드롭인된
# 이후를 대비해 미리 만들어 둔 파이프라인이다.
#
# 요구: tigress. 설치: https://tigress.wtf (라이선스 등록 후 다운로드 — 자동 설치 불가).
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "사용법: $0 <src1.c> [src2.c ...]" >&2
  exit 1
fi

if ! command -v tigress >/dev/null 2>&1; then
  echo "→ tigress 미설치 — 소스 난독화(방법 1) 건너뜀 (https://tigress.wtf)" >&2
  printf '%s\n' "$@"
  exit 0
fi

STAGE_DIR="$(mktemp -d)"
echo "→ tigress 소스 난독화 중... ($STAGE_DIR)" >&2

# ff_prot_* 4개 export 심볼은 이름이 바뀌면 wasm-client.ts 계약이 깨지므로 보존한다.
# Flatten(제어 흐름 평탄화) + InitOpaque/AddOpaque(불투명 조건문) + EncodeArithmetic(산술식
# 치환) 조합 — Tigress 문서가 권장하는 표준 조합. Merge는 여러 파일을 하나로 합쳐 함수
# 경계를 더 흐리지만, 여기서는 파일 단위 변환을 유지해 build-wasm.sh 쪽 소스 목록 처리와
# 충돌하지 않게 한다.
for src in "$@"; do
  out="$STAGE_DIR/$(basename "$src")"
  tigress \
    --Environment=x86_64:Linux:Gcc:12.0.0 \
    --Transform=InitOpaque --Functions=* \
    --Transform=Flatten --Functions=*,!ff_prot_init,!ff_prot_set_param,!ff_prot_start_exec,!ff_prot_stop_exec \
    --Transform=EncodeArithmetic --Functions=* \
    --Transform=AddOpaque --Functions=* \
    --out="$out" \
    "$src" >&2
  echo "$out"
done
