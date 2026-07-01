// POST /api/projects/:id/restore — 휴지통의 프로젝트 복원(상위 폴더 체인도 함께 복원)
import { NextResponse } from "next/server";
import { requireApprovedUser } from "@/features/auth/lib/auth-server";
import { restoreProject } from "@/features/workspace/lib/workspace-server";
import { principalFrom } from "@/features/auth/lib/authz";
import { unauthorized, httpError } from "@/app/api/_lib/route";

export const runtime = "nodejs";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApprovedUser();
  if (!auth) return unauthorized();

  const { id } = await ctx.params;
  try {
    await restoreProject({ projectId: id, principal: principalFrom(auth) });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return httpError(e);
  }
}
