// POST /api/folders/:id/restore — 휴지통의 폴더 복원(조상 체인도 함께 복원)
import { NextResponse } from "next/server";
import { requireApprovedUser } from "@/features/auth/lib/auth-server";
import { restoreFolder } from "@/features/workspace/lib/workspace-server";
import { principalFrom } from "@/features/auth/lib/authz";
import { unauthorized, httpError } from "@/app/api/_lib/route";

export const runtime = "nodejs";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApprovedUser();
  if (!auth) return unauthorized();

  const { id } = await ctx.params;
  try {
    await restoreFolder({ folderId: id, principal: principalFrom(auth) });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return httpError(e);
  }
}
