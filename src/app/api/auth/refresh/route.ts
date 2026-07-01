// POST /api/auth/refresh — refresh 쿠키로 access/refresh 회전(rotation)
// 설계: docs/01-authentication.md §6 Phase2
import { NextResponse } from "next/server";
import { prisma } from "@/shared/db/prisma";
import { rotateSession } from "@/features/auth/lib/session-server";
import {
  signToken,
  TOKEN_COOKIE,
  REFRESH_COOKIE,
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
} from "@/features/auth/lib/auth";
import { errorJson } from "@/app/api/_lib/route";

export const runtime = "nodejs";

function clearAuthCookies(res: NextResponse): void {
  res.cookies.set(TOKEN_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  res.cookies.set(REFRESH_COOKIE, "", { httpOnly: true, path: "/api/auth", maxAge: 0 });
}

export async function POST(req: Request) {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const raw = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${REFRESH_COOKIE}=`))
    ?.slice(REFRESH_COOKIE.length + 1);

  if (!raw) {
    const res = errorJson("로그인이 필요합니다.", 401);
    clearAuthCookies(res);
    return res;
  }

  const rotated = await rotateSession(decodeURIComponent(raw));
  if (!rotated) {
    const res = errorJson("세션이 만료되었습니다. 다시 로그인해주세요.", 401);
    clearAuthCookies(res);
    return res;
  }

  const user = await prisma.user.findUnique({ where: { id: rotated.userId } });
  if (!user || user.status !== "APPROVED") {
    const res = errorJson("세션이 만료되었습니다. 다시 로그인해주세요.", 401);
    clearAuthCookies(res);
    return res;
  }

  const token = await signToken({
    sub: user.id,
    email: user.email,
    role: user.role as "ADMIN" | "USER",
    status: user.status,
  });

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
  res.cookies.set(REFRESH_COOKIE, rotated.raw, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/auth",
    maxAge: REFRESH_TTL_SECONDS,
  });
  return res;
}
