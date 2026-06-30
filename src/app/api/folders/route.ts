// /api/folders
//   GET  ?space=SHARE|WORK&parent=<folderId> — 한 단계 자식(폴더+프로젝트) lazy-load (docs/02 §6)
//   POST { name, parentId } — WORK 하위 폴더 생성 (소유자만)
import { NextResponse } from "next/server";
import { requireApprovedUser } from "@/features/auth/lib/auth-server";
import { createFolder, listFolderChildren, WorkspaceError } from "@/features/workspace/lib/workspace-server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = await requireApprovedUser();
  if (!auth) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const spaceParam = searchParams.get("space");
  const space =
    spaceParam === "WORK" ? "WORK" : spaceParam === "SHARE" ? "SHARE" : null;
  if (!space) {
    return NextResponse.json(
      { error: "space 는 SHARE 또는 WORK 여야 합니다." },
      { status: 400 },
    );
  }

  const parent = searchParams.get("parent"); // null → 루트
  const data = await listFolderChildren({ space, parentId: parent, userId: auth.sub });
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  const auth = await requireApprovedUser();
  if (!auth) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  let body: { name?: string; parentId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문" }, { status: 400 });
  }
  if (!body.parentId) {
    return NextResponse.json({ error: "parentId 가 필요합니다." }, { status: 400 });
  }

  try {
    const folder = await createFolder({
      name: body.name ?? "",
      parentId: body.parentId,
      userId: auth.sub,
    });
    return NextResponse.json(
      { folder: { id: folder.id, name: folder.name, parentId: folder.parentId } },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof WorkspaceError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
