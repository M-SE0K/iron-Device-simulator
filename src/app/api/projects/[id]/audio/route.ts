// GET /api/projects/:id/audio — 업로드 음원 바이트 스트리밍 (재생/다운로드)
//   ?download=1 → 첨부(다운로드), 기본 → inline(플레이어 재생)
// WORK 음원은 소유자만 접근. (SHARE 프로젝트는 음원이 없으므로 사실상 WORK 전용)
import { NextResponse } from "next/server";
import { prisma } from "@/shared/db/prisma";
import { requireApprovedUser } from "@/features/auth/lib/auth-server";
import { can, principalFrom } from "@/features/auth/lib/authz";
import { unauthorized, notFound } from "@/app/api/_lib/route";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApprovedUser();
  if (!auth) return unauthorized();

  const { id } = await ctx.params;
  const project = await prisma.project.findUnique({
    where: { id },
    select: { spaceType: true, ownerId: true, audio: true, deletedAt: true },
  });

  if (!project || !project.audio || project.deletedAt !== null) {
    return notFound("음원을 찾을 수 없습니다.");
  }
  // 읽기 인가: WORK=소유자, SHARE=승인자 전원 (authz.can 으로 일원화)
  if (!can(principalFrom(auth), "read", project)) {
    return notFound("음원을 찾을 수 없습니다.");
  }

  const { data, mimeType, filename, sizeBytes } = project.audio;
  const download = new URL(req.url).searchParams.get("download") === "1";
  // RFC 5987 — 한글 등 비ASCII 파일명 안전 인코딩
  const encoded = encodeURIComponent(filename);

  return new NextResponse(new Uint8Array(data), {
    status: 200,
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(sizeBytes),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encoded}`,
    },
  });
}
