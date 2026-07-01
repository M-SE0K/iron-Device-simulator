// GET /api/search?space=SHARE|WORK&q=<string> — 전역 이름 검색(플랫), breadcrumb용 ancestors 포함
import { NextResponse } from "next/server";
import { requireApprovedUser } from "@/features/auth/lib/auth-server";
import { searchWorkspace } from "@/features/workspace/lib/workspace-server";
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

  const query = searchParams.get("q") ?? "";
  const data = await searchWorkspace({ space, userId: auth.sub, query });
  return NextResponse.json(data);
}
