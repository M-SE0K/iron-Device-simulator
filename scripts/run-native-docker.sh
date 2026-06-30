#!/bin/bash
set -e

# 프로젝트 루트로 이동 (script/ 하위에서 실행해도 동작)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE="iron-device-sim"
SO_HOST="/Users/m._.se0k/m._.se0k/2026_1/iron-Device/iron-Device/libirontune.so"
SO_CONTAINER="/app/native/libirontune.so"

# DB 접속: 컨테이너 → 호스트에 publish 된 Postgres(5432)
# (docker-compose 의 irontune-db 가 host:5432 로 노출됨)
DB_URL="${DATABASE_URL:-postgresql://irontune:irontune_pw@host.docker.internal:5432/irontune_db?schema=public}"
JWT="${JWT_SECRET:-dev-only-secret-change-in-production-0a1b2c3d4e5f}"

# 0) Postgres 보장 — compose 로 DB 컨테이너 기동(이미 떠 있으면 그대로)
echo "▶ Postgres 컨테이너 확인/기동..."
docker compose -f "$PROJECT_ROOT/docker-compose.yml" up -d postgres

echo ""
echo "▶ Docker 이미지 빌드 중..."
docker build --platform linux/amd64 -t "$IMAGE" "$PROJECT_ROOT"

echo ""
echo "▶ 컨테이너 실행 중 (Native 모드, port 3001)..."
echo "  DB: $DB_URL"
docker run \
  --platform linux/amd64 \
  -p 3001:3000 \
  --add-host=host.docker.internal:host-gateway \
  -e USE_MOCK=false \
  -e USE_QUEUE="${USE_QUEUE:-true}" \
  -e SO_PATH="$SO_CONTAINER" \
  -e DATABASE_URL="$DB_URL" \
  -e JWT_SECRET="$JWT" \
  -v "$SO_HOST":"$SO_CONTAINER" \
  "$IMAGE"
