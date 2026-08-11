#!/usr/bin/env bash
# common.sh — 시나리오 스크립트가 공유하는 로그/단언 헬퍼.
#
# 각 시나리오는 이 파일을 source 한 뒤 check_* 로 개별 항목을 기록하고, 마지막에
# finish 를 호출한다. finish 는 실패가 하나라도 있으면 non-zero 로 끝나므로
# session.sh 가 레이어 단위 PASS/FAIL 을 그대로 exit code 로 읽을 수 있다.
#
# 시나리오 안에서 set -e 를 쓰지 않는 것은 의도적이다 — 첫 실패에서 죽어버리면
# "무엇이 얼마나 깨졌는지"를 한 번에 못 본다. 검증 도구는 끝까지 돌고 전부 보고해야 한다.

if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'
  C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_DIM=""; C_BOLD=""; C_OFF=""
fi

_PASS=0
_FAIL=0
_WARN=0
_FAIL_LINES=()

# 검증 대상 스냅샷이 풀린 경로. session.sh 가 export 한다.
WORK="${WORK:-/work}"

section() { echo; echo "${C_BOLD}── $* ${C_OFF}"; }
info()    { echo "   ${C_DIM}$*${C_OFF}"; }

pass() { _PASS=$((_PASS + 1)); echo "   ${C_GRN}✓${C_OFF} $*"; }
fail() {
  _FAIL=$((_FAIL + 1))
  _FAIL_LINES+=("$*")
  echo "   ${C_RED}✗${C_OFF} $*"
}
warn() { _WARN=$((_WARN + 1)); echo "   ${C_YEL}!${C_OFF} $*"; }

# check_file <경로> [설명] — 스냅샷 안에 파일이 있어야 통과.
check_file() {
  local p="$1" desc="${2:-$1}"
  if [[ -f "$WORK/$p" ]]; then pass "$desc"; else fail "$desc — 파일 없음: $p"; fi
}

# check_absent <경로> <이유> — 스냅샷에 있으면 안 되는 파일(로컬 산출물/비밀).
check_absent() {
  local p="$1" why="$2"
  if [[ -e "$WORK/$p" ]]; then fail "$p 가 스냅샷에 포함됨 — $why"; else pass "$p 미포함"; fi
}

# check_exec <경로> — 실행 권한 비트가 살아 있어야 통과.
# git 은 755/644 두 가지만 보존하므로, 커밋 시점에 비트가 빠지면 클론한 쪽에서
# "Permission denied"로만 보인다. 로컬에서는 chmod 해둔 상태라 절대 재현되지 않는다.
check_exec() {
  local p="$1"
  if [[ ! -f "$WORK/$p" ]]; then fail "$p — 파일 없음(실행 비트 확인 불가)"; return; fi
  if [[ -x "$WORK/$p" ]]; then pass "$p 실행 비트 있음"; else fail "$p 실행 비트 없음 (git update-index --chmod=+x)"; fi
}

# run_step <라벨> <명령...> — 명령을 돌리고 성공/실패를 기록. 출력은 그대로 흘린다.
run_step() {
  local label="$1"; shift
  echo
  info "\$ $*"
  if "$@"; then
    pass "$label"
    return 0
  else
    local rc=$?
    fail "$label (exit $rc)"
    return 1
  fi
}

# expect_fail_step <라벨> <명령...> — "실패해야 정상"인 명령용.
expect_fail_step() {
  local label="$1"; shift
  echo
  info "\$ $* ${C_DIM}(실패를 기대함)${C_OFF}"
  if "$@"; then
    fail "$label — 성공해버렸다(실패를 기대한 케이스)"
    return 1
  else
    pass "$label (기대대로 실패)"
    return 0
  fi
}

finish() {
  echo
  echo "${C_BOLD}   결과: ${C_GRN}${_PASS} pass${C_OFF}, ${C_RED}${_FAIL} fail${C_OFF}, ${C_YEL}${_WARN} warn${C_OFF}"
  if [[ ${_FAIL} -gt 0 ]]; then
    echo "${C_RED}   실패 항목:${C_OFF}"
    local line
    for line in "${_FAIL_LINES[@]}"; do echo "     - $line"; done
    return 1
  fi
  return 0
}

# WASM 산출물의 export 심볼 계약 검증.
# custom/ 에 어떤 알고리즘을 드롭인하든 이 4개 심볼이 살아 있어야 wasm-client.ts 가
# 호출할 수 있다 — 하드닝(wasm-opt/wasm-mutate/상수 XOR)을 거친 뒤에도 유지되는지가
# 특히 중요하다.
check_wasm_exports() {
  local wasm="$1"
  if [[ ! -f "$wasm" ]]; then fail "WASM 산출물 없음: $wasm"; return; fi
  local missing
  missing="$(node -e '
    const fs = require("fs");
    const need = ["ff_prot_init","ff_prot_set_param","ff_prot_start_exec","ff_prot_stop_exec","malloc","free"];
    const m = new WebAssembly.Module(fs.readFileSync(process.argv[1]));
    const have = new Set(WebAssembly.Module.exports(m).map(e => e.name));
    process.stdout.write(need.filter(n => !have.has(n)).join(","));
  ' "$wasm" 2>&1)" || { fail "WASM 파싱 실패: $wasm ($missing)"; return; }

  if [[ -z "$missing" ]]; then
    pass "export 심볼 계약 유지 (ff_prot_* 4개 + malloc/free)"
  else
    fail "export 심볼 누락: $missing — wasm-client.ts 가 이름으로 직접 호출하므로 로드 즉시 깨진다"
  fi
}
