// PATCH /api/admin/users/:id  { status: "APPROVED" | "REJECTED" }
// admin 승인 탭의 토글 동작 (명세 §7, docs/01 §5.3)
import { NextResponse } from "next/server";
import { prisma } from "@/shared/db/prisma";
import { requireAdmin } from "@/features/auth/lib/auth-server";

export const runtime = "nodejs";

const ALLOWED = ["APPROVED", "REJECTED", "PENDING"] as const;
type AllowedStatus = (typeof ALLOWED)[number];

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: "관리자 권한이 필요합니다." }, { status: 403 });
  }

  const { id } = await ctx.params;

  let body: { status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문" }, { status: 400 });
  }

  if (!body.status || !ALLOWED.includes(body.status as AllowedStatus)) {
    return NextResponse.json(
      { error: `status 는 ${ALLOWED.join(", ")} 중 하나여야 합니다.` },
      { status: 400 },
    );
  }

  // 자기 자신 강등 방지 (admin 이 스스로를 잠그는 사고 차단)
  if (id === admin.sub && body.status !== "APPROVED") {
    return NextResponse.json({ error: "자기 자신의 상태는 변경할 수 없습니다." }, { status: 400 });
  }

  try {
    const user = await prisma.user.update({
      where: { id },
      data: { status: body.status as AllowedStatus },
      select: { id: true, email: true, role: true, status: true },
    });
    return NextResponse.json({ user });
  } catch {
    return NextResponse.json({ error: "사용자를 찾을 수 없습니다." }, { status: 404 });
  }
}
