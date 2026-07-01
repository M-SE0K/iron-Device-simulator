// /api/folders/:id  (WORK 소유자만)
//   PATCH  { name } — 폴더 이름 변경
//   PATCH  { parentId } — 폴더 이동(드래그앤드롭). name 과 parentId 는 배타적으로 처리
//   DELETE         — 폴더 삭제 (자식·프로젝트·음원 cascade; 루트 폴더는 삭제 금지)
import { NextResponse } from "next/server";
import { requireApprovedUser } from "@/features/auth/lib/auth-server";
import { deleteFolder, moveFolder, renameFolder } from "@/features/workspace/lib/workspace-server";
import { principalFrom } from "@/features/auth/lib/authz";
import { unauthorized, badBody, readJson, httpError } from "@/app/api/_lib/route";

export const runtime = "nodejs";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApprovedUser();
  if (!auth) return unauthorized();

  const { id } = await ctx.params;
  const body = await readJson<{ name?: string; parentId?: string }>(req);
  if (!body) return badBody();

  try {
    // 이동 요청(parentId) 이면 이동, 아니면 이름 변경 (순서 재배치는 /api/folders/reorder)
    if (typeof body.parentId === "string") {
      const folder = await moveFolder({ folderId: id, newParentId: body.parentId, principal: principalFrom(auth) });
      return NextResponse.json({ folder: { id: folder.id, name: folder.name, parentId: folder.parentId } });
    }
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
