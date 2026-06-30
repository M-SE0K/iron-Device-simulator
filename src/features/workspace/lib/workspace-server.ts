// 서버 전용 공간 모델 헬퍼 (prisma 의존 → edge 에서 import 금지)
// 설계: docs/02-workspace-model.md §5(트리 쿼리), §7(고도화 계획)
import { prisma } from "@/shared/db/prisma";
import type { SpaceType } from "@prisma/client";
import type { FolderListResponse } from "@/features/workspace/types";

/**
 * 사용자의 WORK 루트 폴더를 보장(없으면 생성, 멱등).
 * 가입은 PENDING 으로만 만들어지므로 "최초 로그인" 시점에서 호출한다 (docs/02 §7 Phase1).
 * @returns 해당 사용자의 WORK 루트 Folder
 */
export async function ensureWorkRoot(userId: string, email: string) {
  const existing = await prisma.folder.findFirst({
    where: { spaceType: "WORK", ownerId: userId, parentId: null },
  });
  if (existing) return existing;

  const label = email.split("@")[0] || "내";
  return prisma.folder.create({
    data: {
      name: `${label}의 Work Space`,
      spaceType: "WORK",
      ownerId: userId,
      parentId: null,
    },
  });
}

/**
 * 한 단계 lazy-load: 지정 폴더(parentId)의 직속 자식 폴더 + 프로젝트.
 * - WORK 공간은 ownerId 로 가시성 필터(내 것만 보임) — 다른 사용자의 folderId 를
 *   parent 로 넘겨도 children/projects 가 매칭되지 않아 자연히 차단된다(docs/02 §8).
 * - SHARE 공간은 승인 사용자 전원이 읽기 가능(쓰기 금지는 docs/04 인가 계층에서 강제).
 * - 루트(parentId=null)에는 프로젝트가 매달리지 않으므로 폴더 하위에서만 프로젝트를 조회.
 */
export async function listFolderChildren(opts: {
  space: SpaceType;
  parentId: string | null;
  userId: string;
}): Promise<FolderListResponse> {
  const { space, parentId, userId } = opts;
  const ownerFilter = space === "WORK" ? { ownerId: userId } : {};

  const folders = await prisma.folder.findMany({
    where: { spaceType: space, parentId, ...ownerFilter },
    include: { _count: { select: { children: true, projects: true } } },
    orderBy: { name: "asc" },
  });

  const projects = parentId
    ? await prisma.project.findMany({
        where: { folderId: parentId, spaceType: space, ...ownerFilter },
        include: { audio: { select: { id: true } } },
        orderBy: { createdAt: "desc" },
      })
    : [];

  return {
    folders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      spaceType: f.spaceType,
      parentId: f.parentId,
      childFolderCount: f._count.children,
      projectCount: f._count.projects,
    })),
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      spaceType: p.spaceType,
      folderId: p.folderId,
      baseProjectId: p.baseProjectId,
      hasAudio: p.audio !== null,
      createdAt: p.createdAt.toISOString(),
    })),
  };
}

// ── CRUD (Work Space 한정) ──────────────────────────────
// Share 는 읽기 전용(admin 관리)이므로 아래 변경 작업은 모두 WORK + 소유자 검증을 거친다.
// docs/04 인가 계층이 도입되면 이 가드들을 그쪽으로 승격할 수 있다.

/** 업로드 허용 한도 (DB Bytes 저장 — 짧은 클립 전제) */
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // 50MB
const ALLOWED_AUDIO_EXT = ["wav", "mp3", "flac", "aac", "ogg", "m4a", "opus", "webm"];

/** 라우트가 HTTP 상태로 매핑할 수 있는 작업 오류 */
export class WorkspaceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "WorkspaceError";
  }
}

function cleanName(raw: string | null | undefined): string {
  const name = (raw ?? "").trim();
  if (!name) throw new WorkspaceError(400, "이름을 입력해야 합니다.");
  if (name.length > 100) throw new WorkspaceError(400, "이름은 100자 이하여야 합니다.");
  return name;
}

/** 내가 소유한 WORK 폴더인지 검증 (아니면 throw) */
async function assertOwnedWorkFolder(folderId: string, userId: string) {
  const folder = await prisma.folder.findUnique({ where: { id: folderId } });
  if (!folder || folder.spaceType !== "WORK" || folder.ownerId !== userId) {
    throw new WorkspaceError(404, "폴더를 찾을 수 없습니다.");
  }
  return folder;
}

/** 내가 소유한 WORK 프로젝트인지 검증 (아니면 throw) */
async function assertOwnedWorkProject(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project || project.spaceType !== "WORK" || project.ownerId !== userId) {
    throw new WorkspaceError(404, "프로젝트를 찾을 수 없습니다.");
  }
  return project;
}

/** WORK 하위 폴더 생성 (parentId 는 내 소유 WORK 폴더여야 함) */
export async function createFolder(opts: { name: string; parentId: string; userId: string }) {
  const name = cleanName(opts.name);
  await assertOwnedWorkFolder(opts.parentId, opts.userId);
  return prisma.folder.create({
    data: { name, spaceType: "WORK", parentId: opts.parentId, ownerId: opts.userId },
  });
}

/** WORK 폴더 이름 변경 */
export async function renameFolder(opts: { folderId: string; name: string; userId: string }) {
  const name = cleanName(opts.name);
  await assertOwnedWorkFolder(opts.folderId, opts.userId);
  return prisma.folder.update({ where: { id: opts.folderId }, data: { name } });
}

/** WORK 폴더 삭제 (자식·프로젝트·음원 cascade). 루트는 삭제 금지(사용자 작업공간 보존) */
export async function deleteFolder(opts: { folderId: string; userId: string }) {
  const folder = await assertOwnedWorkFolder(opts.folderId, opts.userId);
  if (folder.parentId === null) {
    throw new WorkspaceError(400, "Work Space 루트 폴더는 삭제할 수 없습니다.");
  }
  await prisma.folder.delete({ where: { id: opts.folderId } });
}

/** 음원 업로드 → WORK 프로젝트 + AudioAsset 생성 (folderId 는 내 소유 WORK 폴더) */
export async function createProjectWithAudio(opts: {
  name: string;
  folderId: string;
  userId: string;
  // ArrayBuffer-backed (Prisma Bytes 입력 타입과 일치) — 라우트에서 new Uint8Array(arrayBuffer) 로 생성
  file: { filename: string; mimeType: string; data: Uint8Array<ArrayBuffer> };
}) {
  const name = cleanName(opts.name);
  await assertOwnedWorkFolder(opts.folderId, opts.userId);

  const { filename, mimeType, data } = opts.file;
  const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  const looksAudio = mimeType.startsWith("audio/") || ALLOWED_AUDIO_EXT.includes(ext);
  if (!looksAudio) {
    throw new WorkspaceError(415, "오디오 파일만 업로드할 수 있습니다.");
  }
  if (data.length === 0) throw new WorkspaceError(400, "빈 파일입니다.");
  if (data.length > MAX_AUDIO_BYTES) {
    throw new WorkspaceError(413, `파일이 너무 큽니다(최대 ${MAX_AUDIO_BYTES / 1024 / 1024}MB).`);
  }

  return prisma.project.create({
    data: {
      name,
      spaceType: "WORK",
      ownerId: opts.userId,
      folderId: opts.folderId,
      audio: {
        create: {
          filename,
          mimeType: mimeType || "application/octet-stream",
          sizeBytes: data.length,
          data,
        },
      },
    },
  });
}

/** WORK 프로젝트 이름 변경 */
export async function renameProject(opts: { projectId: string; name: string; userId: string }) {
  const name = cleanName(opts.name);
  await assertOwnedWorkProject(opts.projectId, opts.userId);
  return prisma.project.update({ where: { id: opts.projectId }, data: { name } });
}

/** WORK 프로젝트 삭제 (음원·측정 cascade) */
export async function deleteProject(opts: { projectId: string; userId: string }) {
  await assertOwnedWorkProject(opts.projectId, opts.userId);
  await prisma.project.delete({ where: { id: opts.projectId } });
}
