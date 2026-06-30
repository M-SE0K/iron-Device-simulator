// POST /api/auth/login — 로그인 (APPROVED 만 JWT 발급, httpOnly 쿠키로 전송)
// 설계: docs/01-authentication.md §5.1
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/auth-server";
import { signToken, TOKEN_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const password = body.password;
  if (!email || !password) {
    return NextResponse.json({ error: "이메일과 비밀번호가 필요합니다." }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  // 사용자 없음 / 비번 불일치를 동일 메시지로 (계정 존재 여부 노출 방지)
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return NextResponse.json({ error: "이메일 또는 비밀번호가 올바르지 않습니다." }, { status: 401 });
  }

  // 승인되지 않은 사용자는 JWT 발급 거부 (명세 §7)
  if (user.status !== "APPROVED") {
    const msg =
      user.status === "PENDING"
        ? "아직 관리자 승인 대기 중입니다."
        : "가입이 거부된 계정입니다.";
    return NextResponse.json({ error: msg, status: user.status }, { status: 403 });
  }

  const token = await signToken({
    sub: user.id,
    email: user.email,
    role: user.role as "ADMIN" | "USER",
    status: "APPROVED",
  });

  const res = NextResponse.json({
    user: { id: user.id, email: user.email, role: user.role, status: user.status },
  });
  res.cookies.set(TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24, // 1일 (ACCESS_TTL 과 일치)
  });
  return res;
}
