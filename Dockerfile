# ─────────────────────────────────────────────────────────────
# Iron Device Audio Analysis — Dockerfile
#
# libirontune.so 는 ELF x86-64(Ubuntu) 빌드 → --platform 필수
#
# 권장: ./scripts/run-native-docker.sh 사용
#
# [수동 빌드]
#   docker build --platform linux/amd64 -t iron-device-sim .
#
# [수동 실행 — Native 모드]
#   docker run --platform linux/amd64 -p 3000:3000 \
#     --add-host=host.docker.internal:host-gateway \
#     -e USE_MOCK=false \
#     -e SO_PATH=/app/native/libirontune.so \
#     -v /host/path/libirontune.so:/app/native/libirontune.so \
#     iron-device-sim
# ─────────────────────────────────────────────────────────────

# Stage 1 — 전체 의존성 설치 (devDeps 포함 — tsx 런타임용)
FROM --platform=linux/amd64 node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# Stage 2 — Next.js 빌드
FROM --platform=linux/amd64 node:20-slim AS builder
WORKDIR /app
# QEMU 에뮬레이션 빌드 안정화: 타입체크/린트 스킵(next.config 가 읽음) + 텔레메트리 끔
#   → 메모리 부족으로 인한 next build EPIPE/OOM 회피 (검증은 로컬 tsc·next build 에서 수행)
ENV DOCKER_BUILD=1
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--max-old-space-size=3072
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# public 디렉토리가 없으면 COPY 실패 방지 — 없을 경우 빈 폴더 생성
RUN mkdir -p /app/public
RUN npm run build

# Stage 3 — 런타임
FROM --platform=linux/amd64 node:20-slim AS runner
WORKDIR /app

# ffmpeg: 오디오 → PCM 변환(Native analyze)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV USE_MOCK=false
ENV SO_PATH=/app/native/libirontune.so

# Next.js 빌드 결과물
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public

# 커스텀 서버 + 소스(tsx 런타임) — 리팩토링으로 lib/ → src/ 이동
COPY --from=builder /app/server.ts ./
COPY --from=builder /app/src ./src/

# 설정 파일
COPY --from=builder /app/next.config.ts ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/package.json ./

COPY --from=builder /app/node_modules ./node_modules

# 기동 스크립트
COPY scripts/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# .so 마운트 디렉토리 + 베이크(런타임에 -v 로 덮어쓰기 가능)
RUN mkdir -p /app/native
COPY libirontune.so ${SO_PATH}

EXPOSE 3000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
