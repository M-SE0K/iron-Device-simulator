// 프로젝트 단건 API (설계: docs/02 §6)
//  - GET    : 메타 + measurement 요약 + 음원 메타(바이트 제외) 조회 (WORK=소유자, SHARE=전원 읽기)
//  - PATCH  : 이름 변경 (WORK 소유자만)
//  - DELETE : 프로젝트 삭제 (WORK 소유자만; 음원·측정 cascade)
import { NextResponse } from "next/server";
import { prisma } from "@/shared/db/prisma";
import { requireApprovedUser } from "@/features/auth/lib/auth-server";
import {
  deleteProject,
  renameProject,
  WorkspaceError,
} from "@/features/workspace/lib/workspace-server";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApprovedUser();
  if (!auth) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

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

  if (!project) {
    return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 404 });
  }

  // WORK 는 소유자만. (존재 사실 노출 최소화를 위해 SHARE 외 타인 WORK 는 404 와 동급 의미)
  if (project.spaceType === "WORK" && project.ownerId !== auth.sub) {
    return NextResponse.json({ error: "접근 권한이 없습니다." }, { status: 403 });
  }

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
    },
  });
}

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
    const project = await renameProject({ projectId: id, name: body.name ?? "", userId: auth.sub });
    return NextResponse.json({ project: { id: project.id, name: project.name } });
  } catch (e) {
    if (e instanceof WorkspaceError) {
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
    await deleteProject({ projectId: id, userId: auth.sub });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof WorkspaceError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
