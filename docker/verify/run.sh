#!/usr/bin/env bash
# run.sh — 호스트에서 도는 진입점. `npm run verify:docker` 가 이걸 부른다.
#
#   npm run verify:docker                          # 기본: L0,L2~L6 (warm) — 10~25분
#   npm run verify:docker -- --full                # L0~L7 전부 (bare 포함) — 40~90분
#   npm run verify:docker -- --layers L0,L3,L5     # 특정 레이어만
#   npm run verify:docker -- --ref develop         # 특정 커밋/브랜치 스냅샷
#   npm run verify:docker -- --dirty               # 커밋 전 워킹 트리 포함
#   npm run verify:docker -- --asio-sdk ~/ASIOSDK  # L7(Windows 크로스) 활성화
#   npm run verify:docker -- --rebuild             # 이미지 강제 재빌드
#   npm run verify:docker -- --clean               # 캐시 볼륨까지 제거하고 종료
#
# 핵심 원칙: 컨테이너에 들어가는 것은 **git 이 추적하는 것뿐**이다. `docker build`
# 컨텍스트에 리포를 통째로 넣거나 워킹 디렉터리를 마운트하면 node_modules,
# public/wasm, .wasm-seed 같은 로컬 산출물이 딸려 들어가 정작 잡아야 할 "빠진 파일"
# 버그를 가려버린다. 그래서 항상 `git archive` 로 tracked-only tar 를 떠서 넣는다.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'
C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'

IMG_BARE=iron-verify:bare
IMG_WARM=iron-verify:warm
VOL_NPM=iron-verify-npm
VOL_CARGO=iron-verify-cargo

REF=HEAD
DIRTY=false
REBUILD=false
ASIO_SDK=""
LAYERS=""
FULL=false
MUTATE_ITERS=20

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --full)       FULL=true; shift ;;
    --layers)     LAYERS="$2"; shift 2 ;;
    --ref)        REF="$2"; shift 2 ;;
    --dirty)      DIRTY=true; shift ;;
    --asio-sdk)   ASIO_SDK="$2"; shift 2 ;;
    --rebuild)    REBUILD=true; shift ;;
    --full-mutate) MUTATE_ITERS=1000; shift ;;
    --clean)
      docker volume rm -f "$VOL_NPM" "$VOL_CARGO" >/dev/null 2>&1 || true
      docker rmi -f "$IMG_BARE" "$IMG_WARM" >/dev/null 2>&1 || true
      echo "✓ 검증 이미지/캐시 볼륨 제거 완료"; exit 0 ;;
    -h|--help)    usage ;;
    *) echo "알 수 없는 옵션: $1 (--help)" >&2; exit 1 ;;
  esac
done

# ── 레이어 배정 ─────────────────────────────────────────────────────────────
# L0~L2 는 "맨 우분투에서 세팅이 되는가"라 bare 이미지에서 돈다. L1 은 emsdk 를 실제로
# 내려받아 느리므로 기본에서 뺀다 — 릴리스 직전 --full 로 한 번 돌리는 용도다.
if [[ -n "$LAYERS" ]]; then
  IFS=',' read -r -a REQUESTED <<< "$LAYERS"
elif [[ "$FULL" == "true" ]]; then
  REQUESTED=(L0 L1 L2 L3 L4 L5 L6 L7)
else
  REQUESTED=(L0 L2 L3 L4 L5 L6)
fi

BARE_LAYERS=(); WARM_LAYERS=()
for l in "${REQUESTED[@]}"; do
  case "$l" in
    L1) BARE_LAYERS+=("$l") ;;
    L0|L2) if [[ " ${REQUESTED[*]} " == *" L1 "* ]]; then BARE_LAYERS+=("$l"); else WARM_LAYERS+=("$l"); fi ;;
    *)  WARM_LAYERS+=("$l") ;;
  esac
done
# L1 을 도는 경우 L0 는 bare 쪽에서 먼저 실행되도록 순서를 보정한다.
if [[ ${#BARE_LAYERS[@]} -gt 0 ]]; then
  SORTED=(); for l in L0 L1 L2; do
    [[ " ${BARE_LAYERS[*]} " == *" $l "* ]] && SORTED+=("$l")
  done
  BARE_LAYERS=(${SORTED[@]+"${SORTED[@]}"})
fi

# ── 전제 확인 ───────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "${C_RED}✗ docker 가 없습니다.${C_OFF}" >&2; exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "${C_RED}✗ Docker 데몬이 떠 있지 않습니다.${C_OFF} Docker Desktop 을 실행한 뒤 다시 시도하세요." >&2
  exit 1
fi

# ── 스냅샷 생성 ─────────────────────────────────────────────────────────────
BUILD_DIR="$HERE/.build"
mkdir -p "$BUILD_DIR"
SNAPSHOT="$BUILD_DIR/snapshot.tar"

echo "${C_BOLD}▶ 스냅샷 생성${C_OFF}"
if [[ "$DIRTY" == "true" ]]; then
  # 커밋 전 워킹 트리를 검증한다. git ls-files 로 "추적 중 + 미삭제" 목록만 뽑아
  # tar 로 뜬다 — 결과적으로 gitignore 대상은 여전히 제외된다.
  echo "   ${C_YEL}--dirty${C_OFF}: 워킹 트리 기준 (커밋되지 않은 변경 포함, gitignore 대상은 여전히 제외)"
  ( cd "$REPO" && git ls-files -z --cached --others --exclude-standard \
      | tar -cf "$SNAPSHOT" --null -T - ) 2>/dev/null
else
  echo "   ref: $REF ($(cd "$REPO" && git rev-parse --short "$REF"))"
  ( cd "$REPO" && git archive --format=tar "$REF" -o "$SNAPSHOT" )
fi
echo "   ${C_DIM}$(du -h "$SNAPSHOT" | cut -f1), $(tar -tf "$SNAPSHOT" | grep -vc '/$') files${C_OFF}"

# ── 이미지 준비 ─────────────────────────────────────────────────────────────
build_image() {
  local tag="$1" dockerfile="$2"
  if [[ "$REBUILD" == "true" ]] || ! docker image inspect "$tag" >/dev/null 2>&1; then
    echo "${C_BOLD}▶ 이미지 빌드: $tag${C_OFF} ${C_DIM}(최초 1회는 오래 걸립니다)${C_OFF}"
    # 빌드 컨텍스트는 docker/verify/ 뿐 — 리포 전체를 넣지 않는다.
    docker build -f "$HERE/$dockerfile" -t "$tag" "$HERE"
  else
    echo "   ${C_DIM}이미지 재사용: $tag (--rebuild 로 강제 재빌드)${C_OFF}"
  fi
}

[[ ${#BARE_LAYERS[@]} -gt 0 ]] && build_image "$IMG_BARE" Dockerfile.bare
[[ ${#WARM_LAYERS[@]} -gt 0 ]] && build_image "$IMG_WARM" Dockerfile.warm

docker volume create "$VOL_NPM"   >/dev/null
docker volume create "$VOL_CARGO" >/dev/null

# ── 실행 ────────────────────────────────────────────────────────────────────
OUT_DIR="$BUILD_DIR/out"
rm -rf "$OUT_DIR"; mkdir -p "$OUT_DIR"

run_session() {
  local image="$1"; shift
  local kind="$1"; shift
  local layers=(${@+"$@"})
  [[ ${#layers[@]} -eq 0 ]] && return 0

  echo
  echo "${C_BOLD}▶ $kind 세션: ${layers[*]}${C_OFF}"

  local args=(
    --rm
    -v "$SNAPSHOT:/snapshot.tar:ro"
    -v "$HERE:/verify:ro"
    -v "$OUT_DIR:/out"
    -e "VERIFY_MUTATE_ITERS=$MUTATE_ITERS"
    -e "OUT_DIR=/out"
  )
  # bare 세션은 캐시 볼륨을 붙이지 않는다 — "아무것도 없는 새 머신"이 전제이므로
  # npm/cargo 캐시가 있으면 검증하려는 상황 자체가 달라진다.
  if [[ "$kind" == "warm" ]]; then
    args+=( -v "$VOL_NPM:/cache/npm" -v "$VOL_CARGO:/cache/cargo-target" )
  fi
  if [[ -n "$ASIO_SDK" ]]; then
    args+=( -v "$(cd "$ASIO_SDK" && pwd):/asio-sdk:ro" )
  fi

  # /verify 는 read-only 마운트라 시나리오가 거기에 쓰지 않도록 되어 있다.
  docker run "${args[@]}" "$image" bash /verify/session.sh "${layers[@]}" || true

  # 세션별 결과를 누적한다(session.sh 는 /out/results.tsv 를 매번 새로 쓴다).
  if [[ -f "$OUT_DIR/results.tsv" ]]; then
    cat "$OUT_DIR/results.tsv" >> "$OUT_DIR/all-results.tsv"
    rm -f "$OUT_DIR/results.tsv"
  fi
}

run_session "$IMG_BARE" bare ${BARE_LAYERS[@]+"${BARE_LAYERS[@]}"}
run_session "$IMG_WARM" warm ${WARM_LAYERS[@]+"${WARM_LAYERS[@]}"}

# ── 요약 ────────────────────────────────────────────────────────────────────
layer_name() {
  case "$1" in
    L0) echo "클론 무결성" ;;
    L1) echo "setup 스크립트 완주" ;;
    L2) echo "bootstrap 온보딩" ;;
    L3) echo "알고리즘 드롭인 → WASM" ;;
    L4) echo "하드닝 체인" ;;
    L5) echo "정적 번들 + 타입/린트" ;;
    L6) echo "Tauri Linux 패키징" ;;
    L7) echo "Windows 크로스" ;;
    *)  echo "" ;;
  esac
}

echo
echo "${C_BOLD}════════ 검증 결과 ════════${C_OFF}"
FAILED=0
if [[ -f "$OUT_DIR/all-results.tsv" ]]; then
  while IFS=$'\t' read -r layer status elapsed; do
    case "$status" in
      PASS) mark="${C_GRN}PASS${C_OFF}" ;;
      FAIL) mark="${C_RED}FAIL${C_OFF}"; FAILED=$((FAILED + 1)) ;;
      *)    mark="${C_YEL}SKIP${C_OFF}" ;;
    esac
    printf '  %-4s %b  %-28s %s\n' "$layer" "$mark" "$(layer_name "$layer")" "${C_DIM}$elapsed${C_OFF}"
  done < "$OUT_DIR/all-results.tsv"
else
  echo "  ${C_RED}결과 파일이 없습니다 — 세션이 시작되지 못했습니다.${C_OFF}"
  FAILED=1
fi

echo
if [[ $FAILED -eq 0 ]]; then
  echo "${C_GRN}${C_BOLD}✓ 모든 레이어 통과${C_OFF}"
  echo "  ${C_DIM}단, Docker 가 덮지 못하는 범위가 있습니다 — docker/verify/MACOS-CHECKLIST.md 를 함께 수행하세요.${C_OFF}"
else
  echo "${C_RED}${C_BOLD}✗ ${FAILED}개 레이어 실패${C_OFF} — 위 로그의 '실패 항목' 을 확인하세요."
fi
exit $((FAILED > 0 ? 1 : 0))
