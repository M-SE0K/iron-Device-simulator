// POST /api/projects/:id/copy — 프로젝트 복사(음원 포함) → { targetFolderId } 아래에 새 프로젝트 생성
import { NextResponse } from "next/server";
import { requireApprovedUser } from "@/features/auth/lib/auth-server";
import { copyProject } from "@/features/workspace/lib/workspace-server";
import { principalFrom } from "@/features/auth/lib/authz";
import { unauthorized, badBody, readJson, httpError } from "@/app/api/_lib/route";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApprovedUser();
  if (!auth) return unauthorized();

  const { id } = await ctx.params;
  const body = await readJson<{ targetFolderId?: string }>(req);
  if (!body || typeof body.targetFolderId !== "string") return badBody();

  try {
    const project = await copyProject({
      projectId: id,
      targetFolderId: body.targetFolderId,
      principal: principalFrom(auth),
    });
    return NextResponse.json({ project: { id: project.id, name: project.name, folderId: project.folderId } });
  } catch (e) {
    return httpError(e);
  }
}
