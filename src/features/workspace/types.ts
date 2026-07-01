// 공간 모델(Share/Work) 트리의 단일 진실원 타입 (설계: docs/02-workspace-model.md)
// 클라이언트·서버 양쪽에서 import 하므로 prisma 등 서버 의존을 두지 않는다.

export type SpaceTypeT = "SHARE" | "WORK";

/** 목록 정렬 파라미터 (GET /api/folders ?sort=&dir=) — 폴더·프로젝트 공통.
 *  "manual" = 사용자가 드래그로 지정한 직접 순서(position 오름차순). dir 는 manual 에서 무시. */
export type SortKey = "name" | "createdAt" | "manual";
export type SortDir = "asc" | "desc";

/** 트리의 폴더 노드 (lazy-load 단위). _count 로 펼침 화살표 표시 여부 결정 */
export interface FolderNode {
  id: string;
  name: string;
  spaceType: SpaceTypeT;
  parentId: string | null;
  childFolderCount: number;
  projectCount: number;
  /** 직접 정렬(manual) 위치. 트리 lazy-load 응답에만 포함(검색/상세엔 없음) → optional */
  position?: number;
}

/** 폴더 하위의 프로젝트 노드 (트리 리프) */
export interface ProjectNode {
  id: string;
  name: string;
  spaceType: SpaceTypeT;
  folderId: string;
  baseProjectId: string | null; // Fork 출처(Work만), null=원본
  hasAudio: boolean; // 업로드된 음원 보유 여부(트리 아이콘 구분용)
  createdAt: string;
  /** 직접 정렬(manual) 위치. 트리 lazy-load 응답에만 포함(검색/상세엔 없음) → optional */
  position?: number;
}

/** GET /api/folders 응답 — 한 단계 자식(폴더+프로젝트) */
export interface FolderListResponse {
  folders: FolderNode[];
  projects: ProjectNode[];
}

/** GET /api/projects/[id] 응답의 measurement 요약(프레임 제외) */
export interface MeasurementSummary {
  id: string;
  label: string;
  speaker: string | null;
  powerW: number | null;
  durationSec: number;
  frameCount: number;
  recordedAt: string;
}

/** 업로드 음원 메타(바이트 제외) */
export interface AudioMeta {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/** 폴더 경로의 조상 노드(루트→...→직속 부모 순) — breadcrumb 렌더용 */
export interface FolderAncestor {
  id: string;
  name: string;
}

/** 프로젝트 상세(우측 메타 패널) */
export interface ProjectDetail extends ProjectNode {
  measurements: MeasurementSummary[];
  audio: AudioMeta | null;
  ancestors: FolderAncestor[];
}

/** 휴지통 항목 */
export interface TrashFolderEntry {
  id: string;
  name: string;
  parentId: string | null;
  deletedAt: string;
}
export interface TrashProjectEntry {
  id: string;
  name: string;
  folderId: string;
  deletedAt: string;
}
export interface TrashListResponse {
  folders: TrashFolderEntry[];
  projects: TrashProjectEntry[];
}

/** GET /api/search 응답 */
export interface SearchResponse {
  folders: (FolderNode & { ancestors: FolderAncestor[] })[];
  projects: (ProjectNode & { ancestors: FolderAncestor[] })[];
}
