// /api/folders
//   GET  ?space=SHARE|WORK&parent=<folderId> — 한 단계 자식(폴더+프로젝트) lazy-load (docs/02 §6)
//   POST { name, parentId } — WORK 하위 폴더 생성 (소유자만)
import { NextResponse } from "next/server";
import { requireApprovedUser } from "@/features/auth/lib/auth-server";
import { createFolder, listFolderChildren } from "@/features/workspace/lib/workspace-server";
import { principalFrom } from "@/features/auth/lib/authz";
import { unauthorized, badBody, badRequest, readJson, httpError } from "@/app/api/_lib/route";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = await requireApprovedUser();
  if (!auth) return unauthorized();

  const { searchParams } = new URL(req.url);
  const spaceParam = searchParams.get("space");
  const space =
    spaceParam === "WORK" ? "WORK" : spaceParam === "SHARE" ? "SHARE" : null;
  if (!space) {
    return badRequest("space 는 SHARE 또는 WORK 여야 합니다.");
  }

  const parent = searchParams.get("parent"); // null → 루트
  const sortParam = searchParams.get("sort");
  const sort =
    sortParam === "name" || sortParam === "createdAt" || sortParam === "manual" ? sortParam : undefined;
  const dirParam = searchParams.get("dir");
  const dir = dirParam === "asc" || dirParam === "desc" ? dirParam : undefined;

  const data = await listFolderChildren({ space, parentId: parent, userId: auth.sub, sort, dir });
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  const auth = await requireApprovedUser();
  if (!auth) return unauthorized();

  const body = await readJson<{ name?: string; parentId?: string }>(req);
  if (!body) return badBody();
  if (!body.parentId) {
    return badRequest("parentId 가 필요합니다.");
  }

  try {
    const folder = await createFolder({
      name: body.name ?? "",
      parentId: body.parentId,
      principal: principalFrom(auth),
    });
    return NextResponse.json(
      { folder: { id: folder.id, name: folder.name, parentId: folder.parentId } },
      { status: 201 },
    );
  } catch (e) {
    return httpError(e);
  }
}
