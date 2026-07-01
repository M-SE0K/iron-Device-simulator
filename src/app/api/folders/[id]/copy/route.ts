// POST /api/folders/:id/copy — 폴더 deep copy(하위 폴더·프로젝트·음원) → { targetParentId } 아래에 복제
import { NextResponse } from "next/server";
import { requireApprovedUser } from "@/features/auth/lib/auth-server";
import { copyFolder } from "@/features/workspace/lib/workspace-server";
import { principalFrom } from "@/features/auth/lib/authz";
import { unauthorized, badBody, readJson, httpError } from "@/app/api/_lib/route";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApprovedUser();
  if (!auth) return unauthorized();

  const { id } = await ctx.params;
  const body = await readJson<{ targetParentId?: string }>(req);
  if (!body || typeof body.targetParentId !== "string") return badBody();

  try {
    await copyFolder({ folderId: id, targetParentId: body.targetParentId, principal: principalFrom(auth) });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return httpError(e);
  }
}
