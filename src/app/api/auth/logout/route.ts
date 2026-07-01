// POST /api/auth/logout — 쿠키 제거 + refresh 세션 폐기
import { NextResponse } from "next/server";
import { TOKEN_COOKIE, REFRESH_COOKIE } from "@/features/auth/lib/auth";
import { revokeSession } from "@/features/auth/lib/session-server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const raw = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${REFRESH_COOKIE}=`))
    ?.slice(REFRESH_COOKIE.length + 1);

  if (raw) {
    await revokeSession(decodeURIComponent(raw)).catch(() => undefined);
  }

  const res = NextResponse.json({ message: "로그아웃되었습니다." });
  res.cookies.set(TOKEN_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  res.cookies.set(REFRESH_COOKIE, "", { httpOnly: true, path: "/api/auth", maxAge: 0 });
  return res;
}
