// 서버 전용 인증 헬퍼 (bcrypt + prisma 의존 → edge 에서 import 금지)
// 설계: docs/01-authentication.md, docs/04-authorization.md
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { prisma } from "@/shared/db/prisma";
import { TOKEN_COOKIE, verifyToken, type AuthTokenPayload } from "@/features/auth/lib/auth";

const BCRYPT_COST = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** 요청 쿠키에서 토큰을 읽어 검증된 payload 반환. 없거나 무효면 null */
export async function getAuthFromCookie(): Promise<AuthTokenPayload | null> {
  const store = await cookies();
  const token = store.get(TOKEN_COOKIE)?.value;
  if (!token) return null;
  return verifyToken(token);
}

/**
 * 승인된(APPROVED) 사용자만 통과시키는 가드.
 * 토큰 claim 뿐 아니라 DB status 를 재확인한다 (무상태 JWT 의 즉시 차단 한계 보완, docs/01 §7).
 * @returns 통과 시 payload, 실패 시 null
 */
export async function requireApprovedUser(): Promise<AuthTokenPayload | null> {
  const auth = await getAuthFromCookie();
  if (!auth) return null;
  const user = await prisma.user.findUnique({ where: { id: auth.sub } });
  if (!user || user.status !== "APPROVED") return null;
  return { ...auth, status: user.status, role: user.role as AuthTokenPayload["role"] };
}

/** ADMIN 역할까지 요구하는 가드 */
export async function requireAdmin(): Promise<AuthTokenPayload | null> {
  const auth = await requireApprovedUser();
  if (!auth || auth.role !== "ADMIN") return null;
  return auth;
}
