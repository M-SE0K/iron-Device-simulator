// POST /api/auth/signup — 회원가입 (status=PENDING 으로 생성, 토큰 미발급)
// 설계: docs/01-authentication.md §5.1
import { NextResponse } from "next/server";
import { prisma } from "@/shared/db/prisma";
import { hashPassword } from "@/features/auth/lib/auth-server";
import { badBody, badRequest, conflict } from "@/app/api/_lib/route";

export const runtime = "nodejs"; // bcrypt/prisma 사용 → node 런타임 강제

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
  if (!/^(?=.*[A-Za-z])(?=.*\d).{10,}$/.test(password)) {
    return badRequest("비밀번호는 10자 이상, 영문과 숫자를 포함해야 합니다.");
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return conflict("이미 가입된 이메일입니다.");
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
