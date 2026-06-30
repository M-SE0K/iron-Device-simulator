// /api/folders/:id  (WORK 소유자만)
//   PATCH  { name } — 폴더 이름 변경
//   DELETE         — 폴더 삭제 (자식·프로젝트·음원 cascade; 루트 폴더는 삭제 금지)
import { NextResponse } from "next/server";
import { requireApprovedUser } from "@/features/auth/lib/auth-server";
import { deleteFolder, renameFolder } from "@/features/workspace/lib/workspace-server";
import { HttpError, principalFrom } from "@/features/auth/lib/authz";

export const runtime = "nodejs";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApprovedUser();
  if (!auth) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const { id } = await ctx.params;
  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문" }, { status: 400 });
  }

  try {
    const folder = await renameFolder({ folderId: id, name: body.name ?? "", principal: principalFrom(auth) });
    return NextResponse.json({ folder: { id: folder.id, name: folder.name } });
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApprovedUser();
  if (!auth) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const { id } = await ctx.params;
  try {
    await deleteFolder({ folderId: id, principal: principalFrom(auth) });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
