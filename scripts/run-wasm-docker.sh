#!/bin/bash
set -e

# ─────────────────────────────────────────────────────────────
# run-wasm-docker.sh — native/ff_prot.c(더미 스피커 보호 알고리즘)를 WASM으로
# 빌드해 Docker로 실행한다. libirontune.so(ELF x86-64) 로딩이 필요 없으므로
# run-native-docker.sh와 달리 --platform 고정/QEMU 에뮬레이션이 필요 없다
# (호스트 아키텍처 그대로 빌드/실행, Apple Silicon도 네이티브 arm64).
# ─────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE="iron-device-sim-wasm"

echo "▶ Docker 이미지 빌드 중 (WASM 엔진)..."
docker build -f "$PROJECT_ROOT/Dockerfile.wasm" -t "$IMAGE" "$PROJECT_ROOT"

echo ""
echo "▶ 컨테이너 실행 중 (WASM 모드, port 3002)..."
docker run \
  -p 3002:3000 \
  -e USE_QUEUE="${USE_QUEUE:-true}" \
  "$IMAGE"
