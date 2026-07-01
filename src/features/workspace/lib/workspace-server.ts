// 서버 전용 공간 모델 헬퍼 (prisma 의존 → edge 에서 import 금지)
// 설계: docs/02-workspace-model.md §5(트리 쿼리), §7(고도화 계획)
import { prisma } from "@/shared/db/prisma";
import type { SpaceType } from "@prisma/client";
import type { FolderListResponse } from "@/features/workspace/types";
import { assertCan, HttpError, type Action, type Principal } from "@/features/auth/lib/authz";

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
type SortKey = "name" | "createdAt" | "manual";
type SortDir = "asc" | "desc";

/** 정렬 파라미터 → prisma orderBy. 폴더·프로젝트 공통(동일 기준 적용).
 *  manual = 사용자가 드래그로 지정한 직접 순서(position 오름차순, createdAt 로 tie-break). */
function orderByFor(sort: SortKey | undefined, dir: SortDir | undefined) {
  if (sort === "manual") return [{ position: "asc" as const }, { createdAt: "asc" as const }];
  if (sort === "name") return { name: dir ?? "asc" };
  if (sort === "createdAt") return { createdAt: dir ?? "desc" };
  return { createdAt: "desc" as const }; // 기본: 최신순
}

export async function listFolderChildren(opts: {
  space: SpaceType;
  parentId: string | null;
  userId: string;
  sort?: SortKey;
  dir?: SortDir;
}): Promise<FolderListResponse> {
  const { space, parentId, userId } = opts;
  const ownerFilter = space === "WORK" ? { ownerId: userId } : {};
  const orderBy = orderByFor(opts.sort, opts.dir);

  const folders = await prisma.folder.findMany({
    where: { spaceType: space, parentId, deletedAt: null, ...ownerFilter },
    include: { _count: { select: { children: true, projects: true } } },
    orderBy,
  });

  const projects = parentId
    ? await prisma.project.findMany({
        where: { folderId: parentId, spaceType: space, deletedAt: null, ...ownerFilter },
        include: { audio: { select: { id: true } } },
        orderBy,
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
      position: f.position,
    })),
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      spaceType: p.spaceType,
      folderId: p.folderId,
      baseProjectId: p.baseProjectId,
      hasAudio: p.audio !== null,
      createdAt: p.createdAt.toISOString(),
      position: p.position,
    })),
  };
}

/** 새 형제의 기본 position — 목록 맨 끝(현재 최대 + 1). manual 정렬 시 생성/이동물이 끝에 붙도록 */
async function nextFolderPosition(parentId: string | null): Promise<number> {
  const last = await prisma.folder.findFirst({
    where: { parentId, deletedAt: null },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  return (last?.position ?? 0) + 1;
}

async function nextProjectPosition(folderId: string): Promise<number> {
  const last = await prisma.project.findFirst({
    where: { folderId, deletedAt: null },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  return (last?.position ?? 0) + 1;
}

// ── CRUD ────────────────────────────────────────────────
// 인가 판단은 모두 authz.can()/assertCan() 로 위임(docs/04 §6 "규칙은 한 곳").
// 자원(부모 폴더/대상 폴더·프로젝트)을 로드한 뒤 principal·action 으로 평가한다.
// spaceType 은 부모/자원에서 파생 → 동일 엔드포인트로 WORK(소유자) / SHARE(ADMIN) 모두 커버.

/** 업로드 허용 한도 (DB Bytes 저장 — 짧은 클립 전제) */
const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // 50MB
const ALLOWED_AUDIO_EXT = ["wav", "mp3", "flac", "aac", "ogg", "m4a", "opus", "webm"];

/** 입력 검증 오류 (인가 외) — authz 의 HttpError 를 공유해 라우트가 한 번에 캐치 */
class WorkspaceError extends HttpError {
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

/** 폴더 로드 + action 인가 (없거나 삭제된 경우 404) */
async function loadFolderFor(folderId: string, action: Action, principal: Principal) {
  const folder = await prisma.folder.findUnique({ where: { id: folderId } });
  if (!folder || folder.deletedAt !== null) throw new WorkspaceError(404, "폴더를 찾을 수 없습니다.");
  assertCan(principal, action, folder);
  return folder;
}

/** 프로젝트 로드 + action 인가 (없거나 삭제된 경우 404) */
async function loadProjectFor(projectId: string, action: Action, principal: Principal) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project || project.deletedAt !== null) throw new WorkspaceError(404, "프로젝트를 찾을 수 없습니다.");
  assertCan(principal, action, project);
  return project;
}

/** 휴지통에 있는 폴더만 로드(복원용). 복원 권한은 update 권한과 동일 취급 */
async function loadFolderForRestore(folderId: string, principal: Principal) {
  const folder = await prisma.folder.findUnique({ where: { id: folderId } });
  if (!folder) throw new WorkspaceError(404, "폴더를 찾을 수 없습니다.");
  assertCan(principal, "update", folder);
  if (folder.deletedAt === null) throw new WorkspaceError(400, "삭제되지 않은 폴더입니다.");
  return folder;
}

/** 휴지통에 있는 프로젝트만 로드(복원용) */
async function loadProjectForRestore(projectId: string, principal: Principal) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new WorkspaceError(404, "프로젝트를 찾을 수 없습니다.");
  assertCan(principal, "update", project);
  if (project.deletedAt === null) throw new WorkspaceError(400, "삭제되지 않은 프로젝트입니다.");
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
      position: await nextFolderPosition(parent.id),
    },
  });
}

/** 폴더 이름 변경 */
export async function renameFolder(opts: { folderId: string; name: string; principal: Principal }) {
  const name = cleanName(opts.name);
  await loadFolderFor(opts.folderId, "update", opts.principal);
  return prisma.folder.update({ where: { id: opts.folderId }, data: { name } });
}

/** parentId 로 반복 BFS — 트리가 얕아(2~3단) 반복 쿼리 비용이 낮음 */
async function collectDescendantFolderIds(rootId: string): Promise<string[]> {
  const ids = [rootId];
  let frontier = [rootId];
  while (frontier.length) {
    const children = await prisma.folder.findMany({
      where: { parentId: { in: frontier } },
      select: { id: true },
    });
    if (!children.length) break;
    frontier = children.map((c) => c.id);
    ids.push(...frontier);
  }
  return ids;
}

/** 휴지통 이동(soft delete) — 자기 자신 + 하위 폴더/프로젝트 전부 cascade */
async function softDeleteFolderCascade(folderId: string): Promise<void> {
  const now = new Date();
  const allIds = await collectDescendantFolderIds(folderId);
  await prisma.$transaction([
    prisma.folder.updateMany({ where: { id: { in: allIds } }, data: { deletedAt: now } }),
    prisma.project.updateMany({ where: { folderId: { in: allIds } }, data: { deletedAt: now } }),
  ]);
}

/** 폴더를 휴지통으로 이동(자식·프로젝트 cascade). 루트는 삭제 금지(작업공간 보존) */
export async function deleteFolder(opts: { folderId: string; principal: Principal }) {
  const folder = await loadFolderFor(opts.folderId, "delete", opts.principal);
  if (folder.parentId === null) {
    throw new WorkspaceError(400, "루트 폴더는 삭제할 수 없습니다.");
  }
  await softDeleteFolderCascade(folder.id);
}

/** parentId 체인을 따라 올라가며 삭제된 조상만 복원(도달 가능성 보장). 하위로는 cascade 안 함 */
async function restoreAncestorChain(parentId: string | null): Promise<void> {
  let currentId = parentId;
  while (currentId) {
    const parent: { id: string; parentId: string | null; deletedAt: Date | null } | null =
      await prisma.folder.findUnique({
        where: { id: currentId },
        select: { id: true, parentId: true, deletedAt: true },
      });
    if (!parent) break;
    if (parent.deletedAt !== null) {
      await prisma.folder.update({ where: { id: parent.id }, data: { deletedAt: null } });
    }
    currentId = parent.parentId;
  }
}

/** 휴지통의 폴더를 복원. 조상도 함께 복원(도달 가능하도록); 하위는 개별 복원 필요 */
export async function restoreFolder(opts: { folderId: string; principal: Principal }) {
  const folder = await loadFolderForRestore(opts.folderId, opts.principal);
  await prisma.folder.update({ where: { id: folder.id }, data: { deletedAt: null } });
  await restoreAncestorChain(folder.parentId);
}

/** 휴지통의 프로젝트를 복원. 상위 폴더 체인도 함께 복원 */
export async function restoreProject(opts: { projectId: string; principal: Principal }) {
  const project = await loadProjectForRestore(opts.projectId, opts.principal);
  await prisma.project.update({ where: { id: project.id }, data: { deletedAt: null } });
  await restoreAncestorChain(project.folderId);
}

/** 조상 체인 조회(루트→...→직속 부모 순) — 프로젝트 상세 breadcrumb 과 검색 히트가 공용 */
export async function loadAncestors(folderId: string | null): Promise<{ id: string; name: string }[]> {
  const chain: { id: string; name: string }[] = [];
  let currentId = folderId;
  while (currentId) {
    const f: { id: string; name: string; parentId: string | null } | null = await prisma.folder.findUnique({
      where: { id: currentId },
      select: { id: true, name: true, parentId: true },
    });
    if (!f) break;
    chain.unshift({ id: f.id, name: f.name });
    currentId = f.parentId;
  }
  return chain;
}

/** 휴지통 목록(스페이스별, WORK 는 소유자만) */
export async function listTrash(opts: { space: SpaceType; userId: string }) {
  const ownerFilter = opts.space === "WORK" ? { ownerId: opts.userId } : {};
  const [folders, projects] = await Promise.all([
    prisma.folder.findMany({
      where: { spaceType: opts.space, deletedAt: { not: null }, ...ownerFilter },
      orderBy: { deletedAt: "desc" },
    }),
    prisma.project.findMany({
      where: { spaceType: opts.space, deletedAt: { not: null }, ...ownerFilter },
      orderBy: { deletedAt: "desc" },
    }),
  ]);
  return {
    folders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId,
      deletedAt: f.deletedAt!.toISOString(),
    })),
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      folderId: p.folderId,
      deletedAt: p.deletedAt!.toISOString(),
    })),
  };
}

/** 전역 이름 검색(플랫) — 트리가 얕아 레벨별 필터보다 이름 기반 전역 검색이 실사용성이 높음 */
export async function searchWorkspace(opts: { space: SpaceType; userId: string; query: string }) {
  const q = opts.query.trim();
  if (!q) return { folders: [], projects: [] };
  const ownerFilter = opts.space === "WORK" ? { ownerId: opts.userId } : {};

  const [folders, projects] = await Promise.all([
    prisma.folder.findMany({
      where: {
        spaceType: opts.space,
        deletedAt: null,
        name: { contains: q, mode: "insensitive" },
        ...ownerFilter,
      },
      include: { _count: { select: { children: true, projects: true } } },
      take: 30,
    }),
    prisma.project.findMany({
      where: {
        spaceType: opts.space,
        deletedAt: null,
        name: { contains: q, mode: "insensitive" },
        ...ownerFilter,
      },
      include: { audio: { select: { id: true } } },
      take: 30,
    }),
  ]);

  const folderHits = await Promise.all(
    folders.map(async (f) => ({
      id: f.id,
      name: f.name,
      spaceType: f.spaceType,
      parentId: f.parentId,
      childFolderCount: f._count.children,
      projectCount: f._count.projects,
      ancestors: await loadAncestors(f.parentId),
    })),
  );
  const projectHits = await Promise.all(
    projects.map(async (p) => ({
      id: p.id,
      name: p.name,
      spaceType: p.spaceType,
      folderId: p.folderId,
      baseProjectId: p.baseProjectId,
      hasAudio: p.audio !== null,
      createdAt: p.createdAt.toISOString(),
      ancestors: await loadAncestors(p.folderId),
    })),
  );

  return { folders: folderHits, projects: projectHits };
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
      position: await nextProjectPosition(folder.id),
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

/** 프로젝트를 휴지통으로 이동(soft delete) */
export async function deleteProject(opts: { projectId: string; principal: Principal }) {
  const project = await loadProjectFor(opts.projectId, "delete", opts.principal);
  await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });
}

// ── 이동 / 복사 (드래그앤드롭·복사/붙여넣기 지원, docs/02 §7 트리 편집) ──────
// 이동/복사는 항상 "같은 공간(spaceType) 내부"에서만 허용한다. 대상 폴더에 create 인가,
// 원본에 update(이동)·read(복사) 인가를 각각 요구 → WORK 는 소유자만, SHARE 는 ADMIN 만.

/** 두 자원이 같은 공간에 속하는지 검증 (공간 간 이동/복사 금지) */
function assertSameSpace(a: SpaceType, b: SpaceType) {
  if (a !== b) throw new WorkspaceError(400, "다른 공간으로는 이동/복사할 수 없습니다.");
}

/** 폴더 이동 — parentId 변경. 루트 이동 금지 + 자기 자신/하위로의 이동(사이클) 차단 */
export async function moveFolder(opts: { folderId: string; newParentId: string; principal: Principal }) {
  const folder = await loadFolderFor(opts.folderId, "update", opts.principal);
  if (folder.parentId === null) throw new WorkspaceError(400, "루트 폴더는 이동할 수 없습니다.");

  const target = await loadFolderFor(opts.newParentId, "create", opts.principal);
  assertSameSpace(folder.spaceType, target.spaceType);

  if (folder.parentId === target.id) return folder; // 이미 해당 폴더 아래 — no-op
  const descendants = await collectDescendantFolderIds(folder.id); // 자기 자신 포함
  if (descendants.includes(target.id)) {
    throw new WorkspaceError(400, "폴더를 자기 자신 또는 하위 폴더로 이동할 수 없습니다.");
  }
  // 대상 폴더 목록 맨 끝에 붙도록 position 재설정(manual 정렬 안정성)
  return prisma.folder.update({
    where: { id: folder.id },
    data: { parentId: target.id, position: await nextFolderPosition(target.id) },
  });
}

/** 프로젝트 이동 — folderId 변경(같은 공간 내) */
export async function moveProject(opts: { projectId: string; newFolderId: string; principal: Principal }) {
  const project = await loadProjectFor(opts.projectId, "update", opts.principal);
  const target = await loadFolderFor(opts.newFolderId, "create", opts.principal);
  assertSameSpace(project.spaceType, target.spaceType);
  if (project.folderId === target.id) return project; // no-op
  return prisma.project.update({
    where: { id: project.id },
    data: { folderId: target.id, position: await nextProjectPosition(target.id) },
  });
}

// ── 직접(manual) 순서 재배치 — 같은 부모 형제 간 position 만 재배정(부모 이동 아님) ──
// 클라이언트가 재배치 후 형제 전체의 새 순서(id 배열)를 넘기면 position = 인덱스로 일괄 저장한다.
// (형제 전체를 재배정하므로 마이그레이션 직후 전원 position=0 인 상태에서도 안전)

/** 폴더 순서 재배치 — 같은 부모(parentId)·공간의 형제 전체를 orderedIds 순서로 position 재배정 */
export async function reorderFolders(opts: {
  space: SpaceType;
  parentId: string | null;
  orderedIds: string[];
  principal: Principal;
}) {
  if (opts.orderedIds.length === 0) return;
  const folders = await prisma.folder.findMany({ where: { id: { in: opts.orderedIds }, deletedAt: null } });
  if (folders.length !== opts.orderedIds.length) {
    throw new WorkspaceError(400, "재배치 대상 폴더를 찾을 수 없습니다.");
  }
  for (const f of folders) {
    if (f.spaceType !== opts.space || f.parentId !== opts.parentId) {
      throw new WorkspaceError(400, "같은 폴더 안에서만 순서를 바꿀 수 있습니다.");
    }
    assertCan(opts.principal, "update", f); // WORK=소유자 / SHARE=ADMIN
  }
  await prisma.$transaction(
    opts.orderedIds.map((id, i) => prisma.folder.update({ where: { id }, data: { position: i } })),
  );
}

/** 프로젝트 순서 재배치 — 같은 폴더(folderId)의 형제 전체를 orderedIds 순서로 position 재배정 */
export async function reorderProjects(opts: { folderId: string; orderedIds: string[]; principal: Principal }) {
  if (opts.orderedIds.length === 0) return;
  const projects = await prisma.project.findMany({ where: { id: { in: opts.orderedIds }, deletedAt: null } });
  if (projects.length !== opts.orderedIds.length) {
    throw new WorkspaceError(400, "재배치 대상 프로젝트를 찾을 수 없습니다.");
  }
  for (const p of projects) {
    if (p.folderId !== opts.folderId) {
      throw new WorkspaceError(400, "같은 폴더 안에서만 순서를 바꿀 수 있습니다.");
    }
    assertCan(opts.principal, "update", p);
  }
  await prisma.$transaction(
    opts.orderedIds.map((id, i) => prisma.project.update({ where: { id }, data: { position: i } })),
  );
}

/** 복사본 이름 — 원본 이름에 접미사(100자 한도 준수) */
function copyName(name: string): string {
  const suffix = " (복사본)";
  const base = name.length + suffix.length > 100 ? name.slice(0, 100 - suffix.length) : name;
  return `${base}${suffix}`;
}

/** 프로젝트 복사(음원 바이트 포함) → 대상 폴더에 새 프로젝트 생성 */
export async function copyProject(opts: { projectId: string; targetFolderId: string; principal: Principal }) {
  const source = await loadProjectFor(opts.projectId, "read", opts.principal);
  const target = await loadFolderFor(opts.targetFolderId, "create", opts.principal);
  assertSameSpace(source.spaceType, target.spaceType);

  const audio = await prisma.audioAsset.findUnique({ where: { projectId: source.id } });
  return prisma.project.create({
    data: {
      name: copyName(source.name),
      spaceType: target.spaceType,
      ownerId: target.spaceType === "WORK" ? opts.principal.userId : null,
      folderId: target.id,
      position: await nextProjectPosition(target.id),
      audio: audio
        ? {
            create: {
              filename: audio.filename,
              mimeType: audio.mimeType,
              sizeBytes: audio.sizeBytes,
              data: new Uint8Array(audio.data),
            },
          }
        : undefined,
    },
  });
}

/** 한 폴더(+직속 프로젝트)를 새 부모 아래로 복제한 뒤 하위 폴더로 재귀 (트리가 얕아 재귀 안전) */
async function copyFolderTree(
  sourceId: string,
  newParentId: string,
  ownerId: string | null,
  space: SpaceType,
  nameOverride?: string,
): Promise<void> {
  const src = await prisma.folder.findUnique({ where: { id: sourceId } });
  if (!src) return;
  const created = await prisma.folder.create({
    data: {
      name: nameOverride ?? src.name,
      spaceType: space,
      parentId: newParentId,
      ownerId,
      position: await nextFolderPosition(newParentId),
    },
  });

  const projects = await prisma.project.findMany({
    where: { folderId: sourceId, deletedAt: null },
    include: { audio: true },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  let pos = 0;
  for (const p of projects) {
    await prisma.project.create({
      data: {
        name: p.name,
        spaceType: space,
        ownerId,
        folderId: created.id,
        position: (pos += 1),
        audio: p.audio
          ? {
              create: {
                filename: p.audio.filename,
                mimeType: p.audio.mimeType,
                sizeBytes: p.audio.sizeBytes,
                data: new Uint8Array(p.audio.data),
              },
            }
          : undefined,
      },
    });
  }

  const subs = await prisma.folder.findMany({
    where: { parentId: sourceId, deletedAt: null },
    select: { id: true },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  for (const s of subs) await copyFolderTree(s.id, created.id, ownerId, space);
}

/** 폴더 복사(하위 폴더·프로젝트·음원 deep copy) → 대상 폴더 아래에 생성 */
export async function copyFolder(opts: { folderId: string; targetParentId: string; principal: Principal }) {
  const source = await loadFolderFor(opts.folderId, "read", opts.principal);
  const target = await loadFolderFor(opts.targetParentId, "create", opts.principal);
  assertSameSpace(source.spaceType, target.spaceType);

  const descendants = await collectDescendantFolderIds(source.id); // 자기 자신 포함
  if (descendants.includes(target.id)) {
    throw new WorkspaceError(400, "폴더를 자기 자신 또는 하위 폴더로 복사할 수 없습니다.");
  }

  const ownerId = source.spaceType === "WORK" ? opts.principal.userId : null;
  await copyFolderTree(source.id, target.id, ownerId, source.spaceType, copyName(source.name));
}
