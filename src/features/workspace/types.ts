// 공간 모델(Share/Work) 트리의 단일 진실원 타입 (설계: docs/02-workspace-model.md)
// 클라이언트·서버 양쪽에서 import 하므로 prisma 등 서버 의존을 두지 않는다.

export type SpaceTypeT = "SHARE" | "WORK";

/** 트리의 폴더 노드 (lazy-load 단위). _count 로 펼침 화살표 표시 여부 결정 */
export interface FolderNode {
  id: string;
  name: string;
  spaceType: SpaceTypeT;
  parentId: string | null;
  childFolderCount: number;
  projectCount: number;
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

/** 프로젝트 상세(우측 메타 패널) */
export interface ProjectDetail extends ProjectNode {
  measurements: MeasurementSummary[];
  audio: AudioMeta | null;
}
