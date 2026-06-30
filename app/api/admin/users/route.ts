// GET /api/admin/users?status=PENDING — 사용자 목록 (admin 전용)
// 설계: docs/01-authentication.md §5.3, docs/04-authorization.md
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: "관리자 권한이 필요합니다." }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status"); // PENDING | APPROVED | REJECTED | null(전체)

  const users = await prisma.user.findMany({
    where: status ? { status: status as "PENDING" | "APPROVED" | "REJECTED" } : undefined,
    select: { id: true, email: true, role: true, status: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ users });
}
