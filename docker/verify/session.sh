#!/usr/bin/env bash
# session.sh — 컨테이너 안에서 도는 레이어 오케스트레이터.
#
#   session.sh L0 L1 L2
#
# 스냅샷 tar 를 /work 에 풀고, 인자로 받은 레이어를 순서대로 실행한 뒤 결과를
# /out/results.tsv 에 남긴다. 한 컨테이너 안에서 순차 실행하는 이유는 앞 레이어가
# 만든 상태(node_modules, 설치된 툴체인)를 뒤 레이어가 그대로 쓰기 위해서다 —
# 레이어마다 컨테이너를 새로 띄우면 npm ci 를 예닐곱 번 반복하게 된다.
#
# 어느 레이어가 실패해도 나머지는 계속 돈다. 검증 도구는 "첫 실패에서 멈추는" 것보다
# "무엇이 얼마나 깨졌는지 한 번에 보여주는" 편이 쓸모 있다.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export WORK="${WORK:-/work}"
OUT_DIR="${OUT_DIR:-/out}"
SNAPSHOT="${SNAPSHOT:-/snapshot.tar}"

source "$HERE/lib/common.sh"

mkdir -p "$OUT_DIR"
RESULTS="$OUT_DIR/results.tsv"
: > "$RESULTS"

# ── 스냅샷 전개 ─────────────────────────────────────────────────────────────
# git archive 산출물이므로 tracked 파일과 그 mode 비트만 들어 있다. 여기서 실수로
# 호스트 디렉터리를 통째로 마운트하면(COPY . 와 같은 효과) 검증 전체가 무의미해진다.
if [[ ! -f "$SNAPSHOT" ]]; then
  echo "✗ 스냅샷이 없습니다: $SNAPSHOT" >&2
  exit 1
fi
rm -rf "$WORK"
mkdir -p "$WORK"
tar -xf "$SNAPSHOT" -C "$WORK"
echo "▶ 스냅샷 전개: $WORK ($(find "$WORK" -type f | wc -l) files)"

# npm 캐시를 볼륨으로 받으면 반복 실행이 훨씬 빠르다(없으면 기본 경로 사용).
[[ -d /cache/npm ]] && npm config set cache /cache/npm --global 2>/dev/null || true

# ── 레이어 실행 ─────────────────────────────────────────────────────────────
declare -A LAYER_SCRIPT=(
  [L0]="L0-clone-integrity.sh"
  [L1]="L1-setup-script.sh"
  [L2]="L2-bootstrap.sh"
  [L3]="L3-dropin-wasm.sh"
  [L4]="L4-harden.sh"
  [L5]="L5-static-bundle.sh"
  [L6]="L6-tauri-linux.sh"
  [L7]="L7-windows-cross.sh"
)

OVERALL=0
for layer in "$@"; do
  script="${LAYER_SCRIPT[$layer]:-}"
  if [[ -z "$script" ]]; then
    echo "✗ 알 수 없는 레이어: $layer" >&2
    OVERALL=1
    continue
  fi

  echo
  echo "════════════════════════════════════════════════════════════════════"
  START=$SECONDS
  rm -f /tmp/"$layer".status

  bash "$HERE/scenarios/$script"
  rc=$?

  ELAPSED=$((SECONDS - START))
  if [[ -f /tmp/$layer.status ]] && [[ "$(cat /tmp/"$layer".status)" == "SKIPPED" ]]; then
    status=SKIP
  elif [[ $rc -eq 0 ]]; then
    status=PASS
  else
    status=FAIL
    OVERALL=1
  fi
  printf '%s\t%s\t%s\n' "$layer" "$status" "${ELAPSED}s" >> "$RESULTS"
  echo "   → $layer: $status (${ELAPSED}s)"
done

exit $OVERALL
