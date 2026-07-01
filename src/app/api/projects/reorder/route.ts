// /api/projects/reorder
//   POST { folderId, orderedIds } — 같은 폴더의 형제 프로젝트 전체를 orderedIds 순서로 재배치(직접 정렬)
import { NextResponse } from "next/server";
import { requireApprovedUser } from "@/features/auth/lib/auth-server";
import { reorderProjects } from "@/features/workspace/lib/workspace-server";
import { principalFrom } from "@/features/auth/lib/authz";
import { unauthorized, badBody, badRequest, readJson, httpError } from "@/app/api/_lib/route";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const auth = await requireApprovedUser();
  if (!auth) return unauthorized();

  const body = await readJson<{ folderId?: string; orderedIds?: string[] }>(req);
  if (!body) return badBody();

  if (!body.folderId) return badRequest("folderId 가 필요합니다.");
  if (!Array.isArray(body.orderedIds)) return badRequest("orderedIds 배열이 필요합니다.");

  try {
    await reorderProjects({ folderId: body.folderId, orderedIds: body.orderedIds, principal: principalFrom(auth) });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return httpError(e);
  }
}
