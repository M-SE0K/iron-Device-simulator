// POST /api/auth/login — 로그인 (APPROVED 만 JWT 발급, httpOnly 쿠키로 전송)
// 설계: docs/01-authentication.md §5.1
import { NextResponse } from "next/server";
import { prisma } from "@/shared/db/prisma";
import { verifyPassword } from "@/features/auth/lib/auth-server";
import { createSession } from "@/features/auth/lib/session-server";
import {
  checkLoginRateLimit,
  recordLoginFailure,
  resetLoginRateLimit,
} from "@/features/auth/lib/login-rate-limit";
import {
  signToken,
  TOKEN_COOKIE,
  REFRESH_COOKIE,
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
} from "@/features/auth/lib/auth";
import { ensureWorkRoot } from "@/features/workspace/lib/workspace-server";
import { badBody, badRequest, errorJson, forbidden } from "@/app/api/_lib/route";

export const runtime = "nodejs";

function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  return xff?.split(",")[0]?.trim() || "unknown";
}

export async function POST(req: Request) {
  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return badBody();
  }

  const email = body.email?.trim().toLowerCase();
  const password = body.password;
  if (!email || !password) {
    return badRequest("이메일과 비밀번호가 필요합니다.");
  }

  const ip = getClientIp(req);
  const rateLimit = checkLoginRateLimit(ip, email);
  if (!rateLimit.allowed) {
    return errorJson("로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.", 429, {
      "Retry-After": String(rateLimit.retryAfterSec ?? 900),
    });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  // 사용자 없음 / 비번 불일치를 동일 메시지로 (계정 존재 여부 노출 방지)
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    recordLoginFailure(ip, email);
    return errorJson("이메일 또는 비밀번호가 올바르지 않습니다.", 401);
  }

  // 승인되지 않은 사용자는 JWT 발급 거부 (명세 §7) — 실패 카운트에는 포함하지 않음
  if (user.status !== "APPROVED") {
    const msg =
      user.status === "PENDING"
        ? "아직 관리자 승인 대기 중입니다."
        : "가입이 거부된 계정입니다.";
    return forbidden(msg);
  }

  resetLoginRateLimit(ip, email);

  // 최초 로그인 시 개인 Work Space 루트를 보장(멱등). 실패해도 로그인은 막지 않는다 (docs/02 §7).
  try {
    await ensureWorkRoot(user.id, user.email);
  } catch (e) {
    console.error("Work 루트 생성 실패:", e);
  }

  const token = await signToken({
    sub: user.id,
    email: user.email,
    role: user.role as "ADMIN" | "USER",
    status: "APPROVED",
  });
  const { raw: refreshToken } = await createSession(user.id);

  const res = NextResponse.json({
    user: { id: user.id, email: user.email, role: user.role, status: user.status },
  });
  res.cookies.set(TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ACCESS_TTL_SECONDS,
  });
  res.cookies.set(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/auth",
    maxAge: REFRESH_TTL_SECONDS,
  });
  return res;
}
