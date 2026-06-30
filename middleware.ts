// Edge 미들웨어 — /admin 페이지 접근 보호 (설계: docs/04-authorization.md §4.3)
// jose 만 사용하므로 edge 런타임에서 동작한다 (bcrypt/prisma 는 import 하지 않음).
// API 라우트(/api/admin/*)는 각 핸들러가 requireAdmin() 으로 자체 가드(DB status 재확인)한다.
import { NextResponse, type NextRequest } from "next/server";
import { TOKEN_COOKIE, verifyToken } from "@/lib/auth";

export async function middleware(req: NextRequest) {
  const token = req.cookies.get(TOKEN_COOKIE)?.value;
  const auth = token ? await verifyToken(token) : null;

  // 로그인 안 됨 → 로그인 페이지로
  if (!auth) {
    const url = new URL("/login", req.url);
    url.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  // 로그인은 됐지만 admin 아님 → 대시보드로
  if (auth.role !== "ADMIN") {
    return NextResponse.redirect(new URL("/", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"],
};
