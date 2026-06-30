// 서버 전용 공간 모델 헬퍼 (prisma 의존 → edge 에서 import 금지)
// 설계: docs/02-workspace-model.md §5(트리 쿼리), §7(고도화 계획)
import { prisma } from "@/shared/db/prisma";
import type { SpaceType } from "@prisma/client";
import type { FolderListResponse } from "@/features/workspace/types";
import { assertCan, HttpError, type Principal } from "@/features/auth/lib/authz";

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

// ── CRUD ────────────────────────────────────────────────
// 인가 판단은 모두 authz.can()/assertCan() 로 위임(docs/04 §6 "규칙은 한 곳").
// 자원(부모 폴더/대상 폴더·프로젝트)을 로드한 뒤 principal·action 으로 평가한다.
// spaceType 은 부모/자원에서 파생 → 동일 엔드포인트로 WORK(소유자) / SHARE(ADMIN) 모두 커버.

/** 업로드 허용 한도 (DB Bytes 저장 — 짧은 클립 전제) */
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // 50MB
const ALLOWED_AUDIO_EXT = ["wav", "mp3", "flac", "aac", "ogg", "m4a", "opus", "webm"];

/** 입력 검증 오류 (인가 외) — authz 의 HttpError 를 공유해 라우트가 한 번에 캐치 */
export class WorkspaceError extends HttpError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = "WorkspaceError";
  }
}

function cleanName(raw: string | null | undefined): string {
  const name = (raw ?? "").trim();
  if (!name) throw new WorkspaceError(400, "이름을 입력해야 합니다.");
  if (name.length > 100) throw new WorkspaceError(400, "이름은 100자 이하여야 합니다.");
  return name;
}

/** 폴더 로드 + action 인가 (없으면 404) */
async function loadFolderFor(folderId: string, action: "create" | "update" | "delete", principal: Principal) {
  const folder = await prisma.folder.findUnique({ where: { id: folderId } });
  if (!folder) throw new WorkspaceError(404, "폴더를 찾을 수 없습니다.");
  assertCan(principal, action, folder);
  return folder;
}

/** 프로젝트 로드 + action 인가 (없으면 404) */
async function loadProjectFor(projectId: string, action: "update" | "delete", principal: Principal) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new WorkspaceError(404, "프로젝트를 찾을 수 없습니다.");
  assertCan(principal, action, project);
  return project;
}

/** 하위 폴더 생성 — 부모에 'create' 인가 통과 시. spaceType/ownerId 는 부모에서 파생 */
export async function createFolder(opts: { name: string; parentId: string; principal: Principal }) {
  const name = cleanName(opts.name);
  const parent = await loadFolderFor(opts.parentId, "create", opts.principal); // 부모 기준 인가
  return prisma.folder.create({
    data: {
      name,
      spaceType: parent.spaceType,
      parentId: parent.id,
      ownerId: parent.spaceType === "WORK" ? opts.principal.userId : null,
    },
  });
}

/** 폴더 이름 변경 */
export async function renameFolder(opts: { folderId: string; name: string; principal: Principal }) {
  const name = cleanName(opts.name);
  await loadFolderFor(opts.folderId, "update", opts.principal);
  return prisma.folder.update({ where: { id: opts.folderId }, data: { name } });
}

/** 폴더 삭제 (자식·프로젝트·음원 cascade). 루트는 삭제 금지(작업공간 보존) */
export async function deleteFolder(opts: { folderId: string; principal: Principal }) {
  const folder = await loadFolderFor(opts.folderId, "delete", opts.principal);
  if (folder.parentId === null) {
    throw new WorkspaceError(400, "루트 폴더는 삭제할 수 없습니다.");
  }
  await prisma.folder.delete({ where: { id: opts.folderId } });
}

/** 음원 업로드 → 프로젝트 + AudioAsset 생성. 대상 폴더에 'create' 인가 통과 시 */
export async function createProjectWithAudio(opts: {
  name: string;
  folderId: string;
  principal: Principal;
  // ArrayBuffer-backed (Prisma Bytes 입력 타입과 일치) — 라우트에서 new Uint8Array(arrayBuffer) 로 생성
  file: { filename: string; mimeType: string; data: Uint8Array<ArrayBuffer> };
}) {
  const name = cleanName(opts.name);
  const folder = await loadFolderFor(opts.folderId, "create", opts.principal);

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
      spaceType: folder.spaceType,
      ownerId: folder.spaceType === "WORK" ? opts.principal.userId : null,
      folderId: folder.id,
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

/** 프로젝트 이름 변경 */
export async function renameProject(opts: { projectId: string; name: string; principal: Principal }) {
  const name = cleanName(opts.name);
  await loadProjectFor(opts.projectId, "update", opts.principal);
  return prisma.project.update({ where: { id: opts.projectId }, data: { name } });
}

/** 프로젝트 삭제 (음원·측정 cascade) */
export async function deleteProject(opts: { projectId: string; principal: Principal }) {
  await loadProjectFor(opts.projectId, "delete", opts.principal);
  await prisma.project.delete({ where: { id: opts.projectId } });
}
