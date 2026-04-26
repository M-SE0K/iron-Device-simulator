#!/bin/bash
set -e

# 프로젝트 루트로 이동 (script/ 하위에서 실행해도 동작)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE="iron-device-sim"
SO_HOST="/Users/m._.se0k/m._.se0k/2026_1/iron-Device/iron-Device/libirontune.so"
SO_CONTAINER="/app/native/libirontune.so"

echo "▶ Docker 이미지 빌드 중..."
docker build --platform linux/amd64 -t "$IMAGE" "$PROJECT_ROOT"

echo ""
echo "▶ 컨테이너 실행 중 (Native 모드, port 3001)..."
docker run \
  --platform linux/amd64 \
  -p 3001:3000 \
  -e USE_MOCK=false \
  -e USE_QUEUE="${USE_QUEUE:-true}" \
  -e SO_PATH="$SO_CONTAINER" \
  -v "$SO_HOST":"$SO_CONTAINER" \
  "$IMAGE"
