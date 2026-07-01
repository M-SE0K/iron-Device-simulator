// PATCH /api/admin/users/:id  { status?: "APPROVED"|"REJECTED"|"PENDING", role?: "ADMIN"|"USER" }
// admin 승인 탭의 토글 동작 (명세 §7, docs/01 §5.3) + 역할(role) 변경
import { NextResponse } from "next/server";
import { prisma } from "@/shared/db/prisma";
import { requireAdmin } from "@/features/auth/lib/auth-server";
import { badBody, badRequest, forbidden, notFound } from "@/app/api/_lib/route";

export const runtime = "nodejs";

const ALLOWED_STATUS = ["APPROVED", "REJECTED", "PENDING"] as const;
type AllowedStatus = (typeof ALLOWED_STATUS)[number];

const ALLOWED_ROLE = ["ADMIN", "USER"] as const;
type AllowedRole = (typeof ALLOWED_ROLE)[number];

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) {
    return forbidden("관리자 권한이 필요합니다.");
  }

  const { id } = await ctx.params;

  let body: { status?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return badBody();
  }

  if (body.status === undefined && body.role === undefined) {
    return badRequest("status 또는 role 중 하나 이상이 필요합니다.");
  }
  if (body.status !== undefined && !ALLOWED_STATUS.includes(body.status as AllowedStatus)) {
    return badRequest(`status 는 ${ALLOWED_STATUS.join(", ")} 중 하나여야 합니다.`);
  }
  if (body.role !== undefined && !ALLOWED_ROLE.includes(body.role as AllowedRole)) {
    return badRequest(`role 은 ${ALLOWED_ROLE.join(", ")} 중 하나여야 합니다.`);
  }

  // 자기 자신 강등/잠금 방지 (admin 이 스스로를 잠그는 사고 차단)
  if (id === admin.sub) {
    if (body.status !== undefined && body.status !== "APPROVED") {
      return badRequest("자기 자신의 상태는 변경할 수 없습니다.");
    }
    if (body.role !== undefined && body.role !== "ADMIN") {
      return badRequest("자기 자신의 역할은 변경할 수 없습니다.");
    }
  }

  try {
    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(body.status !== undefined ? { status: body.status as AllowedStatus } : {}),
        ...(body.role !== undefined ? { role: body.role as AllowedRole } : {}),
      },
      select: { id: true, email: true, role: true, status: true },
    });
    return NextResponse.json({ user });
  } catch {
    return notFound("사용자를 찾을 수 없습니다.");
  }
}
