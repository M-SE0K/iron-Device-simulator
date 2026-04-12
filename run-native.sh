#!/bin/bash
set -e

IMAGE="iron-device-sim"
SO_HOST="/Users/m._.se0k/m._.se0k/2026_1/iron-Device/iron-Device/libirontune.so"
SO_CONTAINER="/app/native/libirontune.so"

echo "▶ Docker 이미지 빌드 중..."
docker build --platform linux/amd64 -t "$IMAGE" .

echo ""
echo "▶ 컨테이너 실행 중 (Native 모드, port 3000)..."
docker run \
  --platform linux/amd64 \
  -p 3000:3000 \
  -e USE_MOCK=false \
  -e SO_PATH="$SO_CONTAINER" \
  -v "$SO_HOST":"$SO_CONTAINER" \
  "$IMAGE"
