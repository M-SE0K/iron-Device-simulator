// refresh 세션(rotation) 관리 — prisma 의존 → edge 에서 import 금지
// 설계: docs/01-authentication.md §6 Phase2
import { randomBytes, createHash } from "node:crypto";
import { prisma } from "@/shared/db/prisma";
import { REFRESH_TTL_SECONDS } from "@/features/auth/lib/auth";

function newRawToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** 로그인 성공 시 새 refresh 세션 발급 */
export async function createSession(userId: string): Promise<{ raw: string }> {
  const raw = newRawToken();
  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
    },
  });
  return { raw };
}

async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * refresh 쿠키의 raw 토큰으로 회전(rotation) 수행.
 * - 존재하지 않음/만료 → null
 * - 이미 폐기된 토큰 재사용 감지(탈취 의심) → 해당 유저의 모든 세션 폐기 후 null
 * - 정상 → 기존 세션 revoke + replacedById 연결, 새 세션 발급
 */
export async function rotateSession(rawToken: string): Promise<{ raw: string; userId: string } | null> {
  const session = await prisma.session.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  if (!session) return null;

  if (session.revokedAt !== null) {
    // 이미 회전(또는 로그아웃)된 토큰이 재사용됨 — 탈취 의심, 해당 유저 전 세션 무효화
    await revokeAllSessionsForUser(session.userId);
    return null;
  }
  if (session.expiresAt.getTime() <= Date.now()) return null;

  const next = newRawToken();
  const nextHash = hashToken(next);
  await prisma.$transaction(async (tx) => {
    const created = await tx.session.create({
      data: {
        userId: session.userId,
        tokenHash: nextHash,
        expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
      },
    });
    await tx.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), replacedById: created.id },
    });
  });

  return { raw: next, userId: session.userId };
}

/** 로그아웃: 해당 refresh 세션만 폐기(best-effort — 존재하지 않아도 무시) */
export async function revokeSession(rawToken: string): Promise<void> {
  await prisma.session
    .updateMany({
      where: { tokenHash: hashToken(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    })
    .catch(() => undefined);
}
