// /api/folders/reorder
//   POST { space, parentId, orderedIds } — 같은 부모의 형제 폴더 전체를 orderedIds 순서로 재배치(직접 정렬)
import { NextResponse } from "next/server";
import { requireApprovedUser } from "@/features/auth/lib/auth-server";
import { reorderFolders } from "@/features/workspace/lib/workspace-server";
import { principalFrom } from "@/features/auth/lib/authz";
import { unauthorized, badBody, badRequest, readJson, httpError } from "@/app/api/_lib/route";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const auth = await requireApprovedUser();
  if (!auth) return unauthorized();

  const body = await readJson<{ space?: string; parentId?: string | null; orderedIds?: string[] }>(req);
  if (!body) return badBody();

  const space = body.space === "WORK" ? "WORK" : body.space === "SHARE" ? "SHARE" : null;
  if (!space) return badRequest("space 는 SHARE 또는 WORK 여야 합니다.");
  if (!Array.isArray(body.orderedIds)) return badRequest("orderedIds 배열이 필요합니다.");
  const parentId = typeof body.parentId === "string" ? body.parentId : null;

  try {
    await reorderFolders({ space, parentId, orderedIds: body.orderedIds, principal: principalFrom(auth) });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return httpError(e);
  }
}
