// /api/folders/:id  (WORK 소유자만)
//   PATCH  { name } — 폴더 이름 변경
//   DELETE         — 폴더 삭제 (자식·프로젝트·음원 cascade; 루트 폴더는 삭제 금지)
import { NextResponse } from "next/server";
import { requireApprovedUser } from "@/features/auth/lib/auth-server";
import { deleteFolder, renameFolder } from "@/features/workspace/lib/workspace-server";
import { principalFrom } from "@/features/auth/lib/authz";
import { unauthorized, badBody, readJson, httpError } from "@/app/api/_lib/route";

export const runtime = "nodejs";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApprovedUser();
  if (!auth) return unauthorized();

  const { id } = await ctx.params;
  const body = await readJson<{ name?: string }>(req);
  if (!body) return badBody();

  try {
    const folder = await renameFolder({ folderId: id, name: body.name ?? "", principal: principalFrom(auth) });
    return NextResponse.json({ folder: { id: folder.id, name: folder.name } });
  } catch (e) {
    return httpError(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApprovedUser();
  if (!auth) return unauthorized();

  const { id } = await ctx.params;
  try {
    await deleteFolder({ folderId: id, principal: principalFrom(auth) });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return httpError(e);
  }
}
