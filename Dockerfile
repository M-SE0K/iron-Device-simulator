# ─────────────────────────────────────────────────────────────
# Iron Device Audio Analysis — Dockerfile
#
# libirontune.so 는 ELF x86-64(Ubuntu) 빌드 → --platform 필수
# DB(인증/프로젝트)는 별도 Postgres 컨테이너에 연결 (DATABASE_URL 주입)
#
# 권장: ./scripts/run-native-docker.sh 사용 (Postgres 기동 + DATABASE_URL 주입까지 처리)
#
# [수동 빌드]
#   docker build --platform linux/amd64 -t iron-device-sim .
#
# [수동 실행 — Native 모드]
#   docker run --platform linux/amd64 -p 3000:3000 \
#     --add-host=host.docker.internal:host-gateway \
#     -e USE_MOCK=false \
#     -e DATABASE_URL="postgresql://irontune:irontune_pw@host.docker.internal:5432/irontune_db?schema=public" \
#     -e JWT_SECRET="..." \
#     -e SO_PATH=/app/native/libirontune.so \
#     -v /host/path/libirontune.so:/app/native/libirontune.so \
#     iron-device-sim
# ─────────────────────────────────────────────────────────────

# Stage 1 — 전체 의존성 설치 (devDeps 포함 — tsx 런타임용)
FROM --platform=linux/amd64 node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# Stage 2 — Prisma Client 생성 + Next.js 빌드
FROM --platform=linux/amd64 node:20-slim AS builder
WORKDIR /app
# QEMU 에뮬레이션 빌드 안정화: 타입체크/린트 스킵(next.config 가 읽음) + 텔레메트리 끔
#   → 메모리 부족으로 인한 next build EPIPE/OOM 회피 (검증은 로컬 tsc·next build 에서 수행)
ENV DOCKER_BUILD=1
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--max-old-space-size=3072
# Prisma 엔진 런타임은 OpenSSL 필요
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# public 디렉토리가 없으면 COPY 실패 방지 — 없을 경우 빈 폴더 생성
RUN mkdir -p /app/public
# 컨테이너(linux-amd64)용 Prisma Client 를 이미지 안에서 직접 생성
RUN npx prisma generate
RUN npm run build

# Stage 3 — 런타임
FROM --platform=linux/amd64 node:20-slim AS runner
WORKDIR /app

# ffmpeg: 오디오 → PCM 변환(Native analyze) / openssl: Prisma 엔진
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg openssl \
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

# Prisma 스키마/마이그레이션/시드 (기동 시 migrate deploy 용)
COPY --from=builder /app/prisma ./prisma/

# 설정 파일
COPY --from=builder /app/next.config.ts ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/package.json ./

# node_modules 는 builder 에서 복사 (prisma generate 산출물 .prisma/client 포함)
COPY --from=builder /app/node_modules ./node_modules

# 기동 스크립트 (migrate deploy → seed → server)
COPY scripts/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# .so 마운트 디렉토리 + 베이크(런타임에 -v 로 덮어쓰기 가능)
RUN mkdir -p /app/native
COPY libirontune.so ${SO_PATH}

EXPOSE 3000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
