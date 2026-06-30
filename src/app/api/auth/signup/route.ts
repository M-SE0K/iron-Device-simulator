// POST /api/auth/signup — 회원가입 (status=PENDING 으로 생성, 토큰 미발급)
// 설계: docs/01-authentication.md §5.1
import { NextResponse } from "next/server";
import { prisma } from "@/shared/db/prisma";
import { hashPassword } from "@/features/auth/lib/auth-server";

export const runtime = "nodejs"; // bcrypt/prisma 사용 → node 런타임 강제

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
  if (password.length < 8) {
    return NextResponse.json({ error: "비밀번호는 8자 이상이어야 합니다." }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "이미 가입된 이메일입니다." }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);
  await prisma.user.create({
    data: { email, passwordHash }, // role=USER, status=PENDING (스키마 기본값)
  });

  // 토큰을 발급하지 않는다 — admin 승인 후 로그인 가능 (명세 §7)
  return NextResponse.json(
    { message: "가입 신청이 접수되었습니다. 관리자 승인 후 로그인할 수 있습니다." },
    { status: 201 },
  );
}
