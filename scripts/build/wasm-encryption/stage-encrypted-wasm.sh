#!/usr/bin/env bash
# scripts/build/wasm-encryption/stage-encrypted-wasm.sh — Tauri 패키징(build-tauri.sh) 전용.
# build-desktop.sh가 만든 평문 ff_prot.wasm을 암호화해 Tauri 번들 리소스로
# 옮기고, out/ 안의 평문 사본은 지운다.
#
# Tauri는 frontendDist(out/) 를 통째로 패키지에 넣는다 — JS가 fetch를 안 한다고 평문
# .wasm이 패키지 안에 안 남는 게 아니다. 그래서 이 스크립트가 반드시 필요하다:
#   1) native/wasm-engine/.wasm-key 없으면 생성(머신당 1회, git 제외 — 빌드마다 재생성하면
#      wasm 내용이 안 바뀌어도 wasm_key.rs가 바뀌어 불필요한 cargo 전체 리빌드가 남는다)
#   2) 그 키로 src-tauri/src/wasm_key.rs 작성(git 제외 — 없으면 cargo build가 실패한다)
#   3) $WASM_OUT_DIR/ff_prot.wasm → src-tauri/resources/ff_prot.wasm.enc 암호화
#      (src-tauri/tauri.conf.json의 bundle.resources가 이 경로를 번들에 넣는다)
#   4) out/$WASM_DIR_NAME/ff_prot.wasm 이 있으면 삭제 — ff_prot.js(글루)는 평문으로
#      남겨둔다(부트스트랩에 필요, 비밀 아님).
#
# build:desktop(순수 정적 웹 번들, npx serve out)에는 이 스크립트를 쓰지 않는다 — 브라우저
# 탭엔 복호화 키를 안전히 둘 방법이 없어 방법 5(암호화)는 Tauri 패키징에만 적용된다.
set -euo pipefail
cd "$(dirname "$0")/../../.."

WASM_OUT_DIR="public/wasm"
WASM_DIR_NAME="wasm"

if [[ ! -f "$WASM_OUT_DIR/ff_prot.wasm" ]]; then
  echo "✗ $WASM_OUT_DIR/ff_prot.wasm 이 없습니다 — 먼저 build-desktop.sh를 실행하세요." >&2
  exit 1
fi

SEED_FILE="native/wasm-engine/.wasm-seed"
if [[ ! -f "$SEED_FILE" ]]; then
  echo "→ WASM 키 seed 최초 생성: $SEED_FILE (머신당 1회, git 제외)"
  # v2: AES 키가 아니라 seed 재료(SEED_A/SEED_B/SALT)를 저장한다 — 실제 키는
  # HKDF로 런타임 파생(derive-wasm-key.js). 바이너리에 키 상수를 남기지 않기 위함.
  node -e "const c=require('crypto');process.stdout.write(JSON.stringify({seedA:c.randomBytes(32).toString('hex'),seedB:c.randomBytes(32).toString('hex'),salt:c.randomBytes(16).toString('hex')}))" > "$SEED_FILE"
fi

node scripts/build/wasm-encryption/gen-wasm-key-rs.js "$SEED_FILE" "src-tauri/src/wasm_key.rs"

mkdir -p src-tauri/resources
node scripts/build/wasm-encryption/encrypt-wasm.js "$WASM_OUT_DIR/ff_prot.wasm" "src-tauri/resources/ff_prot.wasm.enc" "$SEED_FILE"

OUT_WASM_FILE="out/$WASM_DIR_NAME/ff_prot.wasm"
if [[ -f "$OUT_WASM_FILE" ]]; then
  rm -f "$OUT_WASM_FILE"
  echo "→ $OUT_WASM_FILE 삭제 (평문 사본 제거 — ff_prot.js 글루만 out/에 남음)"
fi

# 배포 경로에는 평문 리소스가 있어선 안 된다. wasm_asset.rs의 평문 폴백은 배포 빌드에
# 컴파일되지 않지만(plain-wasm 피처 off), 이전 --dev 스테이징(stage-dev-wasm.sh)이 남긴
# 평문 src-tauri/resources/ff_prot.wasm 이 리소스 디렉터리에 잔존해 혼동/오배포되는 것을
# 막기 위해 배포 스테이징에서 확실히 제거한다(기본 tauri.conf.json은 .enc만 번들하지만,
# 잔재가 남아 있는 것 자체가 리스크다).
PLAIN_RESOURCE="src-tauri/resources/ff_prot.wasm"
if [[ -f "$PLAIN_RESOURCE" ]]; then
  rm -f "$PLAIN_RESOURCE"
  echo "→ $PLAIN_RESOURCE 삭제 (배포 경로에는 평문 리소스를 두지 않음)"
fi

echo "✓ 암호화 리소스 스테이징 완료: src-tauri/resources/ff_prot.wasm.enc"
