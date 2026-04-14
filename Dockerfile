# ─────────────────────────────────────────────────────────────
# Iron Device Audio Analysis — Dockerfile
#
# libirontune.so 는 ELF x86-64(Ubuntu) 빌드 → --platform 필수
#
# [빌드]
#   docker build --platform linux/amd64 -t iron-device-sim .
#
# [실행 — Mock 모드]
#   docker run --platform linux/amd64 -p 3000:3000 iron-device-sim
#
# [실행 — Native 모드]
#   docker run --platform linux/amd64 -p 3000:3000 \
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
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# public 디렉토리가 없으면 COPY 실패 방지 — 없을 경우 빈 폴더 생성
RUN mkdir -p /app/public
RUN npm run build

# Stage 3 — 런타임
FROM --platform=linux/amd64 node:20-slim AS runner
WORKDIR /app

# ffmpeg: 오디오 파일 → PCM 변환 (NativeEngine analyze용)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV USE_MOCK=false
ENV SO_PATH=/app/native/libirontune.so

# Next.js 빌드 결과물
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public

# 커스텀 서버 + 라이브러리 소스 (tsx로 실행)
COPY --from=builder /app/server.ts ./
COPY --from=builder /app/lib/ws-engine.ts ./lib/
COPY --from=builder /app/lib/types.ts ./lib/
COPY --from=builder /app/lib/logger.ts ./lib/
COPY --from=builder /app/lib/utils.ts ./lib/

# 설정 파일
COPY --from=builder /app/next.config.ts ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/package.json ./

# 전체 node_modules 복사 (tsx + ws + koffi 포함)
COPY --from=deps /app/node_modules ./node_modules

# .so 마운트 디렉토리
RUN mkdir -p /app/native

# .so 파일을 이미지에 포함할 경우 주석 해제:
# COPY libirontune.so ${SO_PATH}

EXPOSE 3000
CMD ["npx", "tsx", "server.ts"]
