// 프로젝트 단건 API (설계: docs/02 §6)
//  - GET    : 메타 + measurement 요약 + 음원 메타(바이트 제외) 조회 (WORK=소유자, SHARE=전원 읽기)
//  - PATCH  : 이름 변경(name) 또는 이동(folderId, 드래그앤드롭) — WORK 소유자만
//  - DELETE : 프로젝트 삭제 (WORK 소유자만; 음원·측정 cascade)
import { NextResponse } from "next/server";
import { prisma } from "@/shared/db/prisma";
import { requireApprovedUser } from "@/features/auth/lib/auth-server";
import { deleteProject, loadAncestors, moveProject, renameProject } from "@/features/workspace/lib/workspace-server";
import { can, principalFrom } from "@/features/auth/lib/authz";
import { unauthorized, badBody, notFound, readJson, httpError } from "@/app/api/_lib/route";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApprovedUser();
  if (!auth) return unauthorized();

  const { id } = await ctx.params;

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      measurements: {
        select: {
          id: true,
          label: true,
          speaker: true,
          powerW: true,
          durationSec: true,
          frameCount: true,
          recordedAt: true,
        },
        orderBy: { recordedAt: "desc" },
      },
      audio: { select: { filename: true, mimeType: true, sizeBytes: true } },
    },
  });

  if (!project || project.deletedAt !== null) {
    return notFound("프로젝트를 찾을 수 없습니다.");
  }

  // 읽기 인가: SHARE=승인자 전원, WORK=소유자 (authz.can 으로 일원화)
  if (!can(principalFrom(auth), "read", project)) {
    return notFound("프로젝트를 찾을 수 없습니다.");
  }

  const ancestors = await loadAncestors(project.folderId);

  return NextResponse.json({
    project: {
      id: project.id,
      name: project.name,
      spaceType: project.spaceType,
      folderId: project.folderId,
      baseProjectId: project.baseProjectId,
      hasAudio: project.audio !== null,
      createdAt: project.createdAt.toISOString(),
      measurements: project.measurements.map((m) => ({
        ...m,
        recordedAt: m.recordedAt.toISOString(),
      })),
      audio: project.audio,
      ancestors,
    },
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApprovedUser();
  if (!auth) return unauthorized();

  const { id } = await ctx.params;
  const body = await readJson<{ name?: string; folderId?: string }>(req);
  if (!body) return badBody();

  try {
    // 이동 요청(folderId) 이면 이동, 아니면 이름 변경 (순서 재배치는 /api/projects/reorder)
    if (typeof body.folderId === "string") {
      const project = await moveProject({ projectId: id, newFolderId: body.folderId, principal: principalFrom(auth) });
      return NextResponse.json({ project: { id: project.id, name: project.name, folderId: project.folderId } });
    }
    const project = await renameProject({ projectId: id, name: body.name ?? "", principal: principalFrom(auth) });
    return NextResponse.json({ project: { id: project.id, name: project.name } });
  } catch (e) {
    return httpError(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApprovedUser();
  if (!auth) return unauthorized();

  const { id } = await ctx.params;
  try {
    await deleteProject({ projectId: id, principal: principalFrom(auth) });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return httpError(e);
  }
}
