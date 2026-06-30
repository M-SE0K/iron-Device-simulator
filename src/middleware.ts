// Edge 미들웨어 — 대시보드(/) 및 /admin 페이지 접근 보호 (설계: docs/04-authorization.md §4.3)
// jose 만 사용하므로 edge 런타임에서 동작한다 (bcrypt/prisma 는 import 하지 않음).
// API 라우트(/api/admin/*)는 각 핸들러가 requireAdmin() 으로 자체 가드(DB status 재확인)한다.
import { NextResponse, type NextRequest } from "next/server";
import { TOKEN_COOKIE, verifyToken } from "@/features/auth/lib/auth";

export async function middleware(req: NextRequest) {
  const token = req.cookies.get(TOKEN_COOKIE)?.value;
  const auth = token ? await verifyToken(token) : null;

  const isAdminPath = req.nextUrl.pathname.startsWith("/admin");

  // 접근 거부 → 로그인 페이지로 보내는 헬퍼 (로그인 후 원래 경로로 복귀)
  const redirectToLogin = () => {
    const url = new URL("/login", req.url);
    url.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(url);
  };

  // 로그인 안 됨 → 로그인 페이지로 (유효한 JWT 를 가진 클라이언트만 통과)
  if (!auth) {
    return redirectToLogin();
  }

  // /admin 은 ADMIN 역할까지 요구. ADMIN 아니면(USER 토큰 포함) 무조건 로그인을 요구.
  if (isAdminPath && auth.role !== "ADMIN") {
    return redirectToLogin();
  }

  return NextResponse.next();
}

export const config = {
  // 대시보드(/) 와 /admin 보호. 정적 자산·API·로그인 페이지는 제외.
  matcher: ["/", "/admin/:path*"],
};
