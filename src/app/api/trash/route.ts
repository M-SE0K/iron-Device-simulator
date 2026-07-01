// GET /api/trash?space=SHARE|WORK — 휴지통 목록(폴더+프로젝트, WORK는 소유자만)
import { NextResponse } from "next/server";
import { requireApprovedUser } from "@/features/auth/lib/auth-server";
import { listTrash } from "@/features/workspace/lib/workspace-server";
import { unauthorized, badRequest } from "@/app/api/_lib/route";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = await requireApprovedUser();
  if (!auth) return unauthorized();

  const { searchParams } = new URL(req.url);
  const spaceParam = searchParams.get("space");
  const space = spaceParam === "WORK" ? "WORK" : spaceParam === "SHARE" ? "SHARE" : null;
  if (!space) {
    return badRequest("space 는 SHARE 또는 WORK 여야 합니다.");
  }

  const data = await listTrash({ space, userId: auth.sub });
  return NextResponse.json(data);
}
