#!/usr/bin/env bash
# scripts/build/wasm-encryption/stage-dev-wasm.sh — build-tauri.sh --dev 전용. 암호화 없이 평문 ff_prot.wasm을
# 그대로 Tauri 번들 리소스로 옮긴다. 시드/키/AES-GCM(stage-encrypted-wasm.sh)이 전혀
# 필요 없다 — 알고리즘 담당자가 암호화 파이프라인을 몰라도 되게 하기 위한 전용 경로다.
#
#   1) $WASM_OUT_DIR/ff_prot.wasm(평문) → src-tauri/resources/ff_prot.wasm 로 복사
#      (tauri.dev-wasm.conf.json의 bundle.resources가 이 경로를 번들에 넣는다)
#   2) src-tauri/resources/ff_prot.wasm.enc 가 없으면 빈 플레이스홀더를 만든다 — 기본
#      tauri.conf.json의 bundle.resources가 이 파일의 "존재"를 요구하기 때문이다(내용은
#      쓰이지 않는다 — --dev 빌드는 plain-wasm 피처가 켜져 src-tauri/src/wasm_asset.rs가
#      평문 리소스를 우선 사용한다. 이 피처는 배포/--devtools 빌드에는 꺼져 있어 그쪽에선
#      평문 폴백 자체가 컴파일되지 않는다).
#
# out/의 평문 사본은 지우지 않는다 — --dev 빌드는 평문이 들어가도 상관없는
# 알고리즘 개발 전용 빌드다(배포 금지).
set -euo pipefail
cd "$(dirname "$0")/../../.."

WASM_OUT_DIR="public/wasm"

if [[ ! -f "$WASM_OUT_DIR/ff_prot.wasm" ]]; then
  echo "✗ $WASM_OUT_DIR/ff_prot.wasm 이 없습니다 — 먼저 build-desktop.sh를 실행하세요." >&2
  exit 1
fi

mkdir -p src-tauri/resources
cp "$WASM_OUT_DIR/ff_prot.wasm" src-tauri/resources/ff_prot.wasm
echo "✓ 평문 리소스 스테이징 완료: src-tauri/resources/ff_prot.wasm (암호화 없음 — 배포 금지)"

if [[ ! -f src-tauri/resources/ff_prot.wasm.enc ]]; then
  : > src-tauri/resources/ff_prot.wasm.enc
  echo "→ 플레이스홀더 생성: src-tauri/resources/ff_prot.wasm.enc (내용 미사용 — 번들러 파일 존재 검사 통과용)"
fi
