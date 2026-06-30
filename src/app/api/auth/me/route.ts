// GET /api/auth/me — 현재 로그인 사용자 정보 (쿠키 기반)
import { NextResponse } from "next/server";
import { getAuthFromCookie } from "@/features/auth/lib/auth-server";

export const runtime = "nodejs";

export async function GET() {
  const auth = await getAuthFromCookie();
  if (!auth) {
    return NextResponse.json({ user: null }, { status: 401 });
  }
  return NextResponse.json({
    user: { id: auth.sub, email: auth.email, role: auth.role, status: auth.status },
  });
}
