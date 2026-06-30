// POST /api/auth/logout — 쿠키 제거
import { NextResponse } from "next/server";
import { TOKEN_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ message: "로그아웃되었습니다." });
  res.cookies.set(TOKEN_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
