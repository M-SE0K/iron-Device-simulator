"use client";

// 공간 모델 트리 탐색 + Work Space 음원 CRUD (설계: docs/02-workspace-model.md §6·§7)
// 좌측: Share/Work 트리(lazy-load). Work 노드엔 폴더/음원 CRUD 액션.
// 우측: 선택 프로젝트 메타 + measurement 요약 + (Work) 오디오 플레이어/다운로드.
//
// 트리 상태는 폴더 children 을 folderId 로 캐시하는 중앙 모델로 관리한다(변경 후 해당 노드만 재로딩).
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  FileAudio,
  FilePlus2,
  Folder as FolderIcon,
  FolderPlus,
  Loader2,
  Pencil,
  Search,
  Share2,
  Trash2,
  Upload,
  User as UserIcon,
  X,
} from "lucide-react";
import type {
  FolderListResponse,
  FolderNode,
  ProjectDetail,
  ProjectNode,
  SearchResponse,
  SortKey,
  SortDir,
  SpaceTypeT,
} from "@/features/workspace/types";
import ProjectAnalysisPanel from "@/features/workspace/components/ProjectAnalysisPanel";
import TrashPanel from "@/features/workspace/components/TrashPanel";

const ROOT_KEY: Record<SpaceTypeT, string> = { SHARE: "__SHARE__", WORK: "__WORK__" };

async function fetchChildren(
  space: SpaceTypeT,
  folderId: string | null,
  sort: { key: SortKey; dir: SortDir },
): Promise<FolderListResponse> {
  const qs = new URLSearchParams({ space, sort: sort.key, dir: sort.dir });
  if (folderId) qs.set("parent", folderId);
  const res = await fetch(`/api/folders?${qs.toString()}`);
  if (!res.ok) throw new Error("폴더를 불러오지 못했습니다.");
  return res.json();
}

async function fetchSearch(space: SpaceTypeT, q: string): Promise<SearchResponse> {
  const qs = new URLSearchParams({ space, q });
  const res = await fetch(`/api/search?${qs.toString()}`);
  if (!res.ok) throw new Error("검색에 실패했습니다.");
  return res.json();
}

/** 모달 상태 — 텍스트 입력형(prompt) / 확인형(confirm) */
type ModalState =
  | { kind: "prompt"; title: string; label: string; value: string; confirmText: string; onConfirm: (v: string) => void }
  | { kind: "confirm"; title: string; message: string; danger: boolean; confirmText: string; onConfirm: () => void };

/** 드래그 중인 항목 — sourceKey 는 이동 후 재로딩할 원본 부모 캐시 키(폴더=parentKey, 프로젝트=folderId) */
interface DragItem {
  kind: "folder" | "project";
  id: string;
  space: SpaceTypeT;
  sourceKey: string;
}

/** 복사/붙여넣기 클립보드 */
interface ClipboardItem {
  kind: "folder" | "project";
  id: string;
  name: string;
  space: SpaceTypeT;
}

/** 노드 렌더링에 필요한 트리 컨텍스트(중앙 상태 + 액션) */
interface TreeCtx {
  cache: Record<string, FolderListResponse>;
  expanded: Set<string>;
  loadingKeys: Set<string>;
  selectedId: string | null;
  busy: boolean;
  toggle: (space: SpaceTypeT, folder: FolderNode) => void;
  selectProject: (p: ProjectNode) => void;
  onCreateFolder: (space: SpaceTypeT, parent: FolderNode) => void;
  onUpload: (space: SpaceTypeT, folder: FolderNode) => void;
  onRenameFolder: (space: SpaceTypeT, folder: FolderNode) => void;
  onDeleteFolder: (space: SpaceTypeT, folder: FolderNode) => void;
  onRenameProject: (p: ProjectNode) => void;
  onDeleteProject: (p: ProjectNode) => void;
  // ── 드래그앤드롭 / 복사·붙여넣기 (WORK 공간만) ──
  clipboard: ClipboardItem | null;
  draggingId: string | null;
  dragOverId: string | null;
  onDragStartItem: (item: DragItem) => void;
  onDragEndItem: () => void;
  onDragOverFolder: (folderId: string) => void;
  onDragLeaveFolder: (folderId: string) => void;
  onDropOnFolder: (space: SpaceTypeT, folderId: string) => void;
  onCopyItem: (item: ClipboardItem) => void;
  onPasteInto: (space: SpaceTypeT, folderId: string) => void;
  onClearClipboard: () => void;
  // ── 순서 재배치(직접 정렬) — 같은 부모 형제 사이 드롭 갭 ──
  draggingKind: "folder" | "project" | null;
  draggingSourceKey: string | null; // 드래그 항목의 부모 키(같은 부모 안에서만 재배치)
  dragOverGapKey: string | null;
  onGapDragOver: (key: string) => void;
  onGapDragLeave: (key: string) => void;
  onReorderDrop: (space: SpaceTypeT, parentKey: string, kind: "folder" | "project", index: number) => void;
}

/** 형제 사이 드롭 갭(직접 정렬 재배치용). 경계에 오버레이되어 레이아웃을 밀지 않는다(-my-1).
 *  현재 드래그 항목과 같은 종류·같은 부모일 때만 활성(preventDefault → 드롭 허용). */
function DropGap({
  space,
  parentKey,
  kind,
  index,
  depth,
  ctx,
}: {
  space: SpaceTypeT;
  parentKey: string;
  kind: "folder" | "project";
  index: number;
  depth: number;
  ctx: TreeCtx;
}) {
  const valid = ctx.draggingKind === kind && ctx.draggingSourceKey === parentKey;
  const gapKey = `${parentKey}::${kind}::${index}`;
  const active = valid && ctx.dragOverGapKey === gapKey;
  return (
    <div
      className="relative z-10 h-2 -my-1"
      style={{ paddingLeft: depth * 14 + 4 }}
      onDragOver={
        valid
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              ctx.onGapDragOver(gapKey);
            }
          : undefined
      }
      onDragLeave={valid ? () => ctx.onGapDragLeave(gapKey) : undefined}
      onDrop={
        valid
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              ctx.onReorderDrop(space, parentKey, kind, index);
            }
          : undefined
      }
    >
      <div
        className={`absolute inset-x-1 top-1/2 -translate-y-1/2 h-0.5 rounded-full transition-colors ${
          active ? "bg-brand-blue" : "bg-transparent"
        }`}
      />
    </div>
  );
}

/** 마운트 후 document.body 로 포털 — 드로어(transform) 컨테이닝 블록을 벗어나 화면 중앙에 렌더 */
function Portal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}

/** 폴더·프로젝트 정렬 드롭다운 — 전체 디자인과 통일한 커스텀 메뉴(아래 방향으로 펼침).
 *  "직접 정렬"은 드래그로 지정한 순서(manual). 드래그 재배치 시 자동으로 이 모드로 전환된다. */
const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "createdAt:desc", label: "최신순" },
  { value: "createdAt:asc", label: "오래된순" },
  { value: "name:asc", label: "이름순 (A–Z)" },
  { value: "name:desc", label: "이름순 (Z–A)" },
  { value: "manual:asc", label: "직접 정렬" },
];

function SortMenu({
  sort,
  onSortChange,
}: {
  sort: { key: SortKey; dir: SortDir };
  onSortChange: (key: SortKey, dir: SortDir) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const value = `${sort.key}:${sort.dir}`;
  const current = SORT_OPTIONS.find((o) => o.value === value) ?? SORT_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="프로젝트 정렬"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-1 px-2 py-1 rounded-md border border-iron-200 bg-white text-xs text-iron-600 hover:bg-iron-50 hover:border-iron-300 transition-colors"
      >
        <ArrowUpDown className="w-3.5 h-3.5 text-iron-400" />
        <span>{current.label}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-iron-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-full mt-1 z-20 w-36 py-1 rounded-lg border border-iron-100 bg-white shadow-lg"
        >
          {SORT_OPTIONS.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  const [key, dir] = o.value.split(":") as [SortKey, SortDir];
                  onSortChange(key, dir);
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-iron-50 ${
                  active ? "text-brand-blue font-medium" : "text-iron-600"
                }`}
              >
                <Check className={`w-3.5 h-3.5 shrink-0 ${active ? "opacity-100" : "opacity-0"}`} />
                {o.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 좌측 트리의 인라인 아이콘 버튼 */
function IconBtn({
  title,
  onClick,
  danger,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`flex items-center justify-center w-6 h-6 rounded-md disabled:opacity-40 ${
        danger ? "text-iron-400 hover:bg-red-50 hover:text-red-600" : "text-iron-400 hover:bg-iron-200 hover:text-iron-700"
      }`}
    >
      {children}
    </button>
  );
}

function FolderTreeNode({
  folder,
  depth,
  space,
  ctx,
}: {
  folder: FolderNode;
  depth: number;
  space: SpaceTypeT;
  ctx: TreeCtx;
}) {
  const open = ctx.expanded.has(folder.id);
  const data = ctx.cache[folder.id];
  const loading = ctx.loadingKeys.has(folder.id);
  const hasChildren = folder.childFolderCount + folder.projectCount > 0;
  const editable = space === "WORK";
  const isDragging = ctx.draggingId === folder.id;
  const isDropOver = ctx.dragOverId === folder.id;
  const canPaste = editable && ctx.clipboard !== null;

  return (
    <div>
      <div
        className={`group flex items-center gap-1 pr-1.5 rounded-md transition-colors ${
          isDropOver ? "bg-brand-blue/10 ring-1 ring-brand-blue/40" : "hover:bg-iron-100"
        } ${isDragging ? "opacity-40" : ""}`}
        style={{ paddingLeft: depth * 14 + 4 }}
        draggable={editable && folder.parentId !== null}
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = "move";
          ctx.onDragStartItem({ kind: "folder", id: folder.id, space, sourceKey: folder.parentId ?? ROOT_KEY[space] });
        }}
        onDragEnd={ctx.onDragEndItem}
        onDragOver={
          editable
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                ctx.onDragOverFolder(folder.id);
              }
            : undefined
        }
        onDragLeave={editable ? () => ctx.onDragLeaveFolder(folder.id) : undefined}
        onDrop={
          editable
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                ctx.onDropOnFolder(space, folder.id);
              }
            : undefined
        }
      >
        <button
          type="button"
          onClick={() => ctx.toggle(space, folder)}
          className="flex-1 min-w-0 flex items-center gap-1.5 py-1.5 text-sm text-iron-700 text-left"
        >
          {hasChildren || editable ? (
            open ? (
              <ChevronDown className="w-3.5 h-3.5 text-iron-400 shrink-0" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-iron-400 shrink-0" />
            )
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          <FolderIcon className="w-4 h-4 text-brand-blue shrink-0" />
          <span className="truncate">{folder.name}</span>
        </button>

        {editable && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <IconBtn title="음원 업로드" disabled={ctx.busy} onClick={() => ctx.onUpload(space, folder)}>
              <Upload className="w-3.5 h-3.5" />
            </IconBtn>
            <IconBtn title="하위 폴더 추가" disabled={ctx.busy} onClick={() => ctx.onCreateFolder(space, folder)}>
              <FolderPlus className="w-3.5 h-3.5" />
            </IconBtn>
            {canPaste && (
              <IconBtn
                title={`'${ctx.clipboard!.name}' 붙여넣기`}
                disabled={ctx.busy}
                onClick={() => ctx.onPasteInto(space, folder.id)}
              >
                <ClipboardPaste className="w-3.5 h-3.5" />
              </IconBtn>
            )}
            {folder.parentId !== null && (
              <IconBtn
                title="복사"
                disabled={ctx.busy}
                onClick={() => ctx.onCopyItem({ kind: "folder", id: folder.id, name: folder.name, space })}
              >
                <Copy className="w-3.5 h-3.5" />
              </IconBtn>
            )}
            <IconBtn title="이름 변경" disabled={ctx.busy} onClick={() => ctx.onRenameFolder(space, folder)}>
              <Pencil className="w-3.5 h-3.5" />
            </IconBtn>
            {folder.parentId !== null && (
              <IconBtn title="삭제" danger disabled={ctx.busy} onClick={() => ctx.onDeleteFolder(space, folder)}>
                <Trash2 className="w-3.5 h-3.5" />
              </IconBtn>
            )}
          </div>
        )}
      </div>

      {open && (
        <div>
          {loading && (
            <div style={{ paddingLeft: (depth + 1) * 14 + 8 }} className="flex items-center gap-2 py-1.5 text-xs text-iron-400">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> 불러오는 중…
            </div>
          )}

          {data?.folders.map((f, i) => (
            <Fragment key={f.id}>
              {editable && (
                <DropGap space={space} parentKey={folder.id} kind="folder" index={i} depth={depth + 1} ctx={ctx} />
              )}
              <FolderTreeNode folder={f} depth={depth + 1} space={space} ctx={ctx} />
            </Fragment>
          ))}
          {editable && data && data.folders.length > 0 && (
            <DropGap
              space={space}
              parentKey={folder.id}
              kind="folder"
              index={data.folders.length}
              depth={depth + 1}
              ctx={ctx}
            />
          )}

          {data?.projects.map((p, i) => (
            <Fragment key={p.id}>
              {editable && (
                <DropGap space={space} parentKey={folder.id} kind="project" index={i} depth={depth + 1} ctx={ctx} />
              )}
            <div
              className={`group flex items-center gap-1 pr-1.5 rounded-md transition-colors ${
                ctx.selectedId === p.id ? "bg-brand-blue/10" : "hover:bg-iron-100"
              } ${ctx.draggingId === p.id ? "opacity-40" : ""}`}
              style={{ paddingLeft: (depth + 1) * 14 + 4 + 14 }}
              draggable={editable}
              onDragStart={
                editable
                  ? (e) => {
                      e.stopPropagation();
                      e.dataTransfer.effectAllowed = "move";
                      ctx.onDragStartItem({ kind: "project", id: p.id, space, sourceKey: p.folderId });
                    }
                  : undefined
              }
              onDragEnd={editable ? ctx.onDragEndItem : undefined}
            >
              <button
                type="button"
                onClick={() => ctx.selectProject(p)}
                className={`flex-1 min-w-0 flex items-center gap-1.5 py-1.5 text-sm text-left ${
                  ctx.selectedId === p.id ? "text-brand-blue font-medium" : "text-iron-700"
                }`}
              >
                <FileAudio className={`w-4 h-4 shrink-0 ${p.hasAudio ? "text-brand-blue" : "text-iron-300"}`} />
                <span className="truncate">{p.name}</span>
              </button>
              {space === "WORK" && (
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <IconBtn
                    title="복사"
                    disabled={ctx.busy}
                    onClick={() => ctx.onCopyItem({ kind: "project", id: p.id, name: p.name, space })}
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </IconBtn>
                  <IconBtn title="이름 변경" disabled={ctx.busy} onClick={() => ctx.onRenameProject(p)}>
                    <Pencil className="w-3.5 h-3.5" />
                  </IconBtn>
                  <IconBtn title="삭제" danger disabled={ctx.busy} onClick={() => ctx.onDeleteProject(p)}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </IconBtn>
                </div>
              )}
            </div>
            </Fragment>
          ))}
          {editable && data && data.projects.length > 0 && (
            <DropGap
              space={space}
              parentKey={folder.id}
              kind="project"
              index={data.projects.length}
              depth={depth + 1}
              ctx={ctx}
            />
          )}

          {data && !loading && data.folders.length === 0 && data.projects.length === 0 && (
            <div style={{ paddingLeft: (depth + 1) * 14 + 8 }} className="py-1.5 text-xs text-iron-300">
              비어 있음
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RootSection({
  title,
  icon,
  space,
  ctx,
  actionSlot,
  sort,
  onSortChange,
  searchQuery,
  onSearchChange,
  searching,
  searchResult,
  onOpenTrash,
}: {
  title: string;
  icon: React.ReactNode;
  space: SpaceTypeT;
  ctx: TreeCtx;
  actionSlot?: React.ReactNode;
  sort: { key: SortKey; dir: SortDir };
  onSortChange: (key: SortKey, dir: SortDir) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  searching: boolean;
  searchResult: SearchResponse | null;
  onOpenTrash: () => void;
}) {
  const roots = ctx.cache[ROOT_KEY[space]]?.folders ?? [];

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 px-2 mb-1 text-xs font-semibold uppercase tracking-wide text-iron-400">
        {icon}
        <span className="flex-1">{title}</span>
        {actionSlot}
        <IconBtn title="휴지통" onClick={onOpenTrash}>
          <Trash2 className="w-3.5 h-3.5" />
        </IconBtn>
      </div>

      <div className="flex items-center gap-1.5 px-2 mb-1.5">
        <div className="flex-1 flex items-center gap-1.5 px-2 py-1 rounded-md bg-iron-50 border border-iron-100">
          <Search className="w-3.5 h-3.5 text-iron-300 shrink-0" />
          <input
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="이름으로 검색…"
            className="flex-1 min-w-0 bg-transparent text-xs text-iron-700 focus:outline-none"
          />
          {searching && <Loader2 className="w-3 h-3 text-iron-300 animate-spin shrink-0" />}
          {searchQuery && !searching && (
            <button type="button" onClick={() => onSearchChange("")} className="shrink-0 text-iron-300 hover:text-iron-500">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <SortMenu sort={sort} onSortChange={onSortChange} />
      </div>

      {/* 복사 클립보드 표시 — 이 스페이스에서 복사한 항목이 있을 때만(붙여넣기는 폴더 hover 아이콘) */}
      {ctx.clipboard && ctx.clipboard.space === space && (
        <div className="mx-2 mb-1.5 flex items-center gap-1.5 px-2 py-1 rounded-md bg-brand-blue/5 border border-brand-blue/20 text-xs text-iron-500">
          <Copy className="w-3 h-3 text-brand-blue shrink-0" />
          <span className="truncate">복사됨: {ctx.clipboard.name}</span>
          <span className="ml-auto shrink-0 text-iron-400">폴더에 붙여넣기</span>
          <button type="button" onClick={ctx.onClearClipboard} className="shrink-0 text-iron-300 hover:text-iron-500">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {searchQuery ? (
        <SearchResultsList space={space} result={searchResult} onSelectProject={ctx.selectProject} />
      ) : roots.length === 0 ? (
        <div className="px-3 py-1.5 text-xs text-iron-300">루트가 없습니다.</div>
      ) : (
        <>
          {roots.map((r, i) => (
            <Fragment key={r.id}>
              {space === "WORK" && (
                <DropGap space={space} parentKey={ROOT_KEY[space]} kind="folder" index={i} depth={0} ctx={ctx} />
              )}
              <FolderTreeNode folder={r} depth={0} space={space} ctx={ctx} />
            </Fragment>
          ))}
          {space === "WORK" && (
            <DropGap space={space} parentKey={ROOT_KEY[space]} kind="folder" index={roots.length} depth={0} ctx={ctx} />
          )}
        </>
      )}
    </div>
  );
}

/** 전역 검색 결과(플랫) — 폴더는 경로 텍스트만, 프로젝트는 클릭해 상세 패널로 이동 */
function SearchResultsList({
  space,
  result,
  onSelectProject,
}: {
  space: SpaceTypeT;
  result: SearchResponse | null;
  onSelectProject: (p: ProjectNode) => void;
}) {
  if (!result) return null;
  const pathOf = (ancestors: { name: string }[]) => ancestors.map((a) => a.name).join(" › ");

  if (result.folders.length === 0 && result.projects.length === 0) {
    return <div className="px-3 py-1.5 text-xs text-iron-300">검색 결과가 없습니다.</div>;
  }

  return (
    <div className="px-1">
      {result.folders.map((f) => (
        <div key={f.id} className="flex items-center gap-1.5 px-2 py-1.5 text-sm text-iron-500">
          <FolderIcon className="w-4 h-4 text-brand-blue shrink-0" />
          <span className="truncate">{f.name}</span>
          <span className="text-xs text-iron-300 truncate">{pathOf(f.ancestors)}</span>
        </div>
      ))}
      {result.projects.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onSelectProject(p)}
          className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm text-iron-700 hover:bg-iron-100 text-left"
        >
          <FileAudio className={`w-4 h-4 shrink-0 ${p.hasAudio ? "text-brand-blue" : "text-iron-300"}`} />
          <span className="truncate">{p.name}</span>
          <span className="text-xs text-iron-300 truncate ml-auto">
            {pathOf(p.ancestors) || (space === "SHARE" ? "Share Space" : "Work Space")}
          </span>
        </button>
      ))}
    </div>
  );
}

interface WorkspaceTreeProps {
  /**
   * "full"(기본) = 트리 + 우측 분석 패널(임베드 대시보드).
   * "nav"        = 트리만(선택 전용). 프로젝트 선택 시 /workspace?project=id 로 이동하고 onSelect 호출.
   *                SideNav 드로어처럼 "선택" 용도로 쓸 때 사용한다.
   */
  variant?: "full" | "nav";
  /** nav 모드에서 프로젝트 선택 직후 호출(드로어 닫기 등) */
  onSelect?: () => void;
}

export default function WorkspaceTree({ variant = "full", onSelect }: WorkspaceTreeProps = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const navMode = variant === "nav";

  const [cache, setCache] = useState<Record<string, FolderListResponse>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());
  const [rootsLoading, setRootsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProjectDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [modal, setModal] = useState<ModalState | null>(null);
  const [busy, setBusy] = useState(false);

  // 드래그앤드롭 / 복사·붙여넣기 (WORK 공간 전용)
  const dragItemRef = useRef<DragItem | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardItem | null>(null);
  // 순서 재배치(직접 정렬) — 형제 사이 드롭 갭용 드래그 컨텍스트
  const [draggingKind, setDraggingKind] = useState<"folder" | "project" | null>(null);
  const [draggingSourceKey, setDraggingSourceKey] = useState<string | null>(null);
  const [dragOverGapKey, setDragOverGapKey] = useState<string | null>(null);

  // 정렬(스페이스별) — 폴더는 항상 name asc 고정, 프로젝트만 정렬 파라미터 적용
  const [sort, setSort] = useState<Record<SpaceTypeT, { key: SortKey; dir: SortDir }>>({
    SHARE: { key: "createdAt", dir: "desc" },
    WORK: { key: "createdAt", dir: "desc" },
  });
  const sortRef = useRef(sort);
  useEffect(() => {
    sortRef.current = sort;
  }, [sort]);
  // 어떤 폴더 키가 어느 스페이스에 속하는지(정렬 변경 시 해당 스페이스의 펼쳐진 폴더만 재로딩하기 위함)
  const folderSpaceRef = useRef<Record<string, SpaceTypeT>>({});

  // 검색(스페이스별, 전역 flat 검색 — 트리 레벨 필터가 아님)
  const [searchQuery, setSearchQuery] = useState<Record<SpaceTypeT, string>>({ SHARE: "", WORK: "" });
  const [searchResult, setSearchResult] = useState<Record<SpaceTypeT, SearchResponse | null>>({
    SHARE: null,
    WORK: null,
  });
  const [searching, setSearching] = useState<Record<SpaceTypeT, boolean>>({ SHARE: false, WORK: false });
  const searchTimers = useRef<Record<SpaceTypeT, ReturnType<typeof setTimeout> | null>>({
    SHARE: null,
    WORK: null,
  });

  // 휴지통(스페이스별)
  const [trashOpen, setTrashOpen] = useState<SpaceTypeT | null>(null);

  // 업로드용 hidden input + 대상 폴더 추적
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTarget = useRef<{ space: SpaceTypeT; folder: FolderNode } | null>(null);

  const setKeyFlag = (setter: typeof setLoadingKeys, key: string, on: boolean) =>
    setter((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  /** 특정 키(폴더 id 또는 루트 sentinel)의 children 을 로드/갱신 */
  const loadChildren = useCallback(async (space: SpaceTypeT, key: string) => {
    const folderId = key === ROOT_KEY[space] ? null : key;
    folderSpaceRef.current[key] = space;
    setKeyFlag(setLoadingKeys, key, true);
    try {
      const data = await fetchChildren(space, folderId, sortRef.current[space]);
      data.folders.forEach((f) => {
        folderSpaceRef.current[f.id] = space;
      });
      setCache((prev) => ({ ...prev, [key]: data }));
    } catch {
      setActionError("폴더를 불러오지 못했습니다.");
    } finally {
      setKeyFlag(setLoadingKeys, key, false);
    }
  }, []);

  /** 정렬 변경 — 해당 스페이스의 루트 + 현재 펼쳐진 폴더만 새 정렬로 재로딩 */
  const onSortChange = useCallback(
    (space: SpaceTypeT, key: SortKey, dir: SortDir) => {
      setSort((prev) => ({ ...prev, [space]: { key, dir } }));
      const keysToReload = [ROOT_KEY[space], ...Array.from(expanded).filter((id) => folderSpaceRef.current[id] === space)];
      // sortRef 는 useEffect 로 다음 렌더에 갱신되므로, 여기서는 직접 최신값을 넘겨 즉시 반영
      sortRef.current = { ...sortRef.current, [space]: { key, dir } };
      keysToReload.forEach((k) => loadChildren(space, k));
    },
    [expanded, loadChildren],
  );

  /** 검색어 변경(디바운스 300ms) — 비어있으면 결과 클리어(트리로 복귀) */
  const runSearch = useCallback((space: SpaceTypeT, q: string) => {
    setSearchQuery((prev) => ({ ...prev, [space]: q }));
    const timer = searchTimers.current[space];
    if (timer) clearTimeout(timer);
    if (!q.trim()) {
      setSearchResult((prev) => ({ ...prev, [space]: null }));
      return;
    }
    searchTimers.current[space] = setTimeout(async () => {
      setSearching((prev) => ({ ...prev, [space]: true }));
      try {
        const data = await fetchSearch(space, q.trim());
        setSearchResult((prev) => ({ ...prev, [space]: data }));
      } catch {
        setActionError("검색에 실패했습니다.");
      } finally {
        setSearching((prev) => ({ ...prev, [space]: false }));
      }
    }, 300);
  }, []);

  // 최초: 루트 로드 — 트리는 드로어(nav)에만 있으므로 nav 모드에서만 로드한다.
  useEffect(() => {
    if (!navMode) {
      setRootsLoading(false); // full(분석 페이지)은 트리 없음 → 로딩 스킵
      return;
    }
    (async () => {
      try {
        await Promise.all([loadChildren("WORK", ROOT_KEY.WORK), loadChildren("SHARE", ROOT_KEY.SHARE)]);
      } catch {
        setError("트리를 불러오지 못했습니다.");
      } finally {
        setRootsLoading(false);
      }
    })();
  }, [navMode, loadChildren]);

  const toggle = useCallback(
    (space: SpaceTypeT, folder: FolderNode) => {
      const willOpen = !expanded.has(folder.id);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (willOpen) next.add(folder.id);
        else next.delete(folder.id);
        return next;
      });
      if (willOpen && !cache[folder.id]) loadChildren(space, folder.id);
    },
    [expanded, cache, loadChildren],
  );

  /** id 로 프로젝트 상세를 로드해 우측 패널에 표시 (full 모드) */
  const selectById = useCallback(async (id: string) => {
    setSelectedId(id);
    setSelected(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/projects/${id}`);
      if (res.ok) setSelected((await res.json()).project as ProjectDetail);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  // 트리 노드 클릭 시 동작: nav 모드는 /workspace 로 이동(선택 전용), full 모드는 인라인 표시
  const selectProject = useCallback(
    (p: ProjectNode) => {
      if (navMode) {
        setSelectedId(p.id);
        router.push(`/workspace?project=${p.id}`);
        onSelect?.();
      } else {
        selectById(p.id);
      }
    },
    [navMode, router, onSelect, selectById],
  );

  // full 모드: URL ?project=<id> 가 바뀌면 해당 프로젝트를 자동 선택 (SideNav 에서 넘어온 선택 반영)
  const projectParam = searchParams.get("project");
  useEffect(() => {
    if (navMode) return;
    if (projectParam) selectById(projectParam);
  }, [navMode, projectParam, selectById]);

  /** 폴더의 부모 키 (루트 폴더면 sentinel) */
  const parentKey = (space: SpaceTypeT, folder: FolderNode) => folder.parentId ?? ROOT_KEY[space];

  /** 변경 작업 공통 래퍼: busy 토글 + 에러 표시 */
  const runMutation = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "작업에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }, []);

  async function apiJson(url: string, init: RequestInit) {
    const res = await fetch(url, init);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? "요청에 실패했습니다.");
    }
    return res.json().catch(() => ({}));
  }

  // ── 액션 핸들러 ──
  const onCreateFolder = (space: SpaceTypeT, parent: FolderNode) =>
    setModal({
      kind: "prompt",
      title: "하위 폴더 추가",
      label: "폴더 이름",
      value: "",
      confirmText: "생성",
      onConfirm: (name) =>
        runMutation(async () => {
          await apiJson("/api/folders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, parentId: parent.id }),
          });
          setExpanded((prev) => new Set(prev).add(parent.id));
          await loadChildren(space, parent.id);
        }),
    });

  const onRenameFolder = (space: SpaceTypeT, folder: FolderNode) =>
    setModal({
      kind: "prompt",
      title: "폴더 이름 변경",
      label: "새 이름",
      value: folder.name,
      confirmText: "변경",
      onConfirm: (name) =>
        runMutation(async () => {
          await apiJson(`/api/folders/${folder.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          });
          await loadChildren(space, parentKey(space, folder));
        }),
    });

  const onDeleteFolder = (space: SpaceTypeT, folder: FolderNode) =>
    setModal({
      kind: "confirm",
      title: "폴더 삭제",
      message: `'${folder.name}' 폴더와 그 안의 모든 하위 폴더·음원이 삭제됩니다. 계속할까요?`,
      danger: true,
      confirmText: "삭제",
      onConfirm: () =>
        runMutation(async () => {
          await apiJson(`/api/folders/${folder.id}`, { method: "DELETE" });
          setSelected(null);
          setSelectedId(null);
          await loadChildren(space, parentKey(space, folder));
        }),
    });

  const onUpload = (space: SpaceTypeT, folder: FolderNode) => {
    uploadTarget.current = { space, folder };
    fileInputRef.current?.click();
  };

  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const target = uploadTarget.current;
    e.target.value = ""; // 같은 파일 재선택 허용
    if (!file || !target) return;
    await runMutation(async () => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("folderId", target.folder.id);
      await apiJson("/api/projects", { method: "POST", body: fd });
      setExpanded((prev) => new Set(prev).add(target.folder.id));
      await loadChildren(target.space, target.folder.id);
    });
  };

  const onRenameProject = (p: ProjectNode) =>
    setModal({
      kind: "prompt",
      title: "프로젝트 이름 변경",
      label: "새 이름",
      value: p.name,
      confirmText: "변경",
      onConfirm: (name) =>
        runMutation(async () => {
          await apiJson(`/api/projects/${p.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          });
          await loadChildren("WORK", p.folderId);
          if (selectedId === p.id) setSelected((s) => (s ? { ...s, name } : s));
        }),
    });

  const onDeleteProject = (p: ProjectNode) =>
    setModal({
      kind: "confirm",
      title: "프로젝트 삭제",
      message: `'${p.name}' 프로젝트와 업로드된 음원·측정 결과가 삭제됩니다. 계속할까요?`,
      danger: true,
      confirmText: "삭제",
      onConfirm: () =>
        runMutation(async () => {
          await apiJson(`/api/projects/${p.id}`, { method: "DELETE" });
          if (selectedId === p.id) {
            setSelected(null);
            setSelectedId(null);
          }
          await loadChildren("WORK", p.folderId);
        }),
    });

  /** 휴지통에서 복원 성공 시 호출 — 원래 있던 위치(parentKey)의 캐시를 재로딩해 트리에 다시 노출 */
  const onRestored = useCallback(
    (space: SpaceTypeT, parentKey: string | null) => {
      loadChildren(space, parentKey ?? ROOT_KEY[space]);
    },
    [loadChildren],
  );

  // ── 드래그앤드롭 이동 / 복사·붙여넣기 핸들러 (WORK 공간 전용) ──
  const onDragStartItem = useCallback((item: DragItem) => {
    dragItemRef.current = item;
    setDraggingId(item.id);
    setDraggingKind(item.kind);
    setDraggingSourceKey(item.sourceKey);
  }, []);

  const onDragEndItem = useCallback(() => {
    dragItemRef.current = null;
    setDraggingId(null);
    setDragOverId(null);
    setDraggingKind(null);
    setDraggingSourceKey(null);
    setDragOverGapKey(null);
  }, []);

  const onGapDragOver = useCallback((key: string) => setDragOverGapKey(key), []);
  const onGapDragLeave = useCallback(
    (key: string) => setDragOverGapKey((cur) => (cur === key ? null : cur)),
    [],
  );

  const onDragOverFolder = useCallback((folderId: string) => setDragOverId(folderId), []);
  const onDragLeaveFolder = useCallback(
    (folderId: string) => setDragOverId((cur) => (cur === folderId ? null : cur)),
    [],
  );

  /** 폴더에 드롭 → 이동(같은 공간). 자기 자신/원위치 드롭은 no-op */
  const onDropOnFolder = useCallback(
    (space: SpaceTypeT, folderId: string) => {
      const item = dragItemRef.current;
      setDragOverId(null);
      setDraggingId(null);
      setDraggingKind(null);
      setDraggingSourceKey(null);
      setDragOverGapKey(null);
      dragItemRef.current = null;
      if (!item || item.space !== space) return;
      if (item.id === folderId || item.sourceKey === folderId) return; // 자기 자신/원위치
      runMutation(async () => {
        if (item.kind === "project") {
          await apiJson(`/api/projects/${item.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folderId }),
          });
        } else {
          await apiJson(`/api/folders/${item.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parentId: folderId }),
          });
        }
        setExpanded((prev) => new Set(prev).add(folderId));
        await Promise.all([loadChildren(space, item.sourceKey), loadChildren(space, folderId)]);
      });
    },
    [runMutation, loadChildren],
  );

  const onCopyItem = useCallback((item: ClipboardItem) => setClipboard(item), []);
  const onClearClipboard = useCallback(() => setClipboard(null), []);

  /** 폴더에 붙여넣기 → 복사(같은 공간). 클립보드는 유지(연속 붙여넣기 허용) */
  const onPasteInto = useCallback(
    (space: SpaceTypeT, folderId: string) => {
      const item = clipboard;
      if (!item || item.space !== space) return;
      runMutation(async () => {
        if (item.kind === "project") {
          await apiJson(`/api/projects/${item.id}/copy`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ targetFolderId: folderId }),
          });
        } else {
          await apiJson(`/api/folders/${item.id}/copy`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ targetParentId: folderId }),
          });
        }
        setExpanded((prev) => new Set(prev).add(folderId));
        await loadChildren(space, folderId);
      });
    },
    [clipboard, runMutation, loadChildren],
  );

  /** 형제 사이 갭에 드롭 → 직접 정렬 재배치(같은 부모·같은 종류만). 재배치 후 자동으로 'manual' 정렬로 전환 */
  const onReorderDrop = useCallback(
    (space: SpaceTypeT, parentKey: string, kind: "folder" | "project", index: number) => {
      const item = dragItemRef.current;
      setDragOverGapKey(null);
      setDraggingId(null);
      setDraggingKind(null);
      setDraggingSourceKey(null);
      dragItemRef.current = null;
      if (!item || item.space !== space || item.kind !== kind) return;
      if (item.sourceKey !== parentKey) return; // 같은 부모 안에서만 재배치

      const data = cache[parentKey];
      const list = kind === "folder" ? data?.folders : data?.projects;
      if (!list) return;
      const ids = list.map((x) => x.id);
      const from = ids.indexOf(item.id);
      if (from === -1) return;
      let to = index;
      if (from < index) to -= 1; // 항목 제거로 목표 인덱스가 한 칸 당겨짐
      if (from === to) return; // 제자리 드롭 — no-op
      const next = [...ids];
      next.splice(from, 1);
      next.splice(to, 0, item.id);

      runMutation(async () => {
        if (kind === "folder") {
          await apiJson("/api/folders/reorder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              space,
              parentId: parentKey === ROOT_KEY[space] ? null : parentKey,
              orderedIds: next,
            }),
          });
        } else {
          await apiJson("/api/projects/reorder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folderId: parentKey, orderedIds: next }),
          });
        }
        // 재배치 결과가 곧 화면 순서가 되도록 '직접 정렬(manual)'로 전환 + 해당 스페이스 재로딩
        onSortChange(space, "manual", "asc");
      });
    },
    [cache, runMutation, onSortChange],
  );

  const ctx: TreeCtx = {
    cache,
    expanded,
    loadingKeys,
    selectedId,
    busy,
    toggle,
    selectProject,
    onCreateFolder,
    onUpload,
    onRenameFolder,
    onDeleteFolder,
    onRenameProject,
    onDeleteProject,
    clipboard,
    draggingId,
    dragOverId,
    onDragStartItem,
    onDragEndItem,
    onDragOverFolder,
    onDragLeaveFolder,
    onDropOnFolder,
    onCopyItem,
    onPasteInto,
    onClearClipboard,
    draggingKind,
    draggingSourceKey,
    dragOverGapKey,
    onGapDragOver,
    onGapDragLeave,
    onReorderDrop,
  };

  return (
    <div className="flex gap-4 h-full">
      {/* hidden file input (업로드) */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.flac,.aac,.ogg,.m4a,.opus,.webm"
        className="hidden"
        onChange={onFileChosen}
      />

      {/* 좌측 트리 — 드로어(nav)에서만. Share·Work 모두 여기서만 노출(분석 페이지엔 트리 없음) */}
      {navMode && (
        <aside className="flex-1 bg-white rounded-xl border border-iron-100 p-2 overflow-auto flex flex-col">
          {actionError && (
            <div className="mb-2 mx-1 px-2 py-1.5 rounded-md bg-red-50 text-red-600 text-xs">{actionError}</div>
          )}
          {busy && (
            <div className="mb-2 mx-1 flex items-center gap-2 px-2 py-1.5 rounded-md bg-iron-100 text-iron-500 text-xs">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> 처리 중…
            </div>
          )}
          {rootsLoading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-iron-400">
              <Loader2 className="w-4 h-4 animate-spin" /> 트리 로딩 중…
            </div>
          ) : error ? (
            <div className="p-4 text-sm text-red-500">{error}</div>
          ) : (
            <>
              <RootSection
                title="Share Space"
                icon={<Share2 className="w-3.5 h-3.5" />}
                space="SHARE"
                ctx={ctx}
                sort={sort.SHARE}
                onSortChange={(key, dir) => onSortChange("SHARE", key, dir)}
                searchQuery={searchQuery.SHARE}
                onSearchChange={(q) => runSearch("SHARE", q)}
                searching={searching.SHARE}
                searchResult={searchResult.SHARE}
                onOpenTrash={() => setTrashOpen("SHARE")}
              />
              <RootSection
                title="내 Work Space"
                icon={<UserIcon className="w-3.5 h-3.5" />}
                space="WORK"
                ctx={ctx}
                sort={sort.WORK}
                onSortChange={(key, dir) => onSortChange("WORK", key, dir)}
                searchQuery={searchQuery.WORK}
                onSearchChange={(q) => runSearch("WORK", q)}
                searching={searching.WORK}
                searchResult={searchResult.WORK}
                onOpenTrash={() => setTrashOpen("WORK")}
              />
            </>
          )}
        </aside>
      )}

      {trashOpen && (
        <TrashPanel space={trashOpen} onClose={() => setTrashOpen(null)} onRestored={onRestored} />
      )}

      {/* 우측 메타 패널 — nav 모드(선택 전용)에서는 렌더하지 않는다 */}
      {!navMode && (
      <section className="flex-1 bg-white rounded-xl border border-iron-100 p-6 overflow-auto">
        {detailLoading ? (
          <div className="h-full flex items-center justify-center text-iron-400 gap-2">
            <Loader2 className="w-5 h-5 animate-spin" /> 불러오는 중…
          </div>
        ) : !selected ? (
          <div className="h-full flex flex-col items-center justify-center text-iron-300">
            <FileAudio className="w-10 h-10 mb-3" />
            <p className="text-sm">좌측 상단 메뉴(☰)에서 프로젝트를 선택하세요.</p>
          </div>
        ) : (
          <ProjectDetailPanel
            project={selected}
            onRename={() => {
              const node: ProjectNode = {
                id: selected.id,
                name: selected.name,
                spaceType: selected.spaceType,
                folderId: selected.folderId,
                baseProjectId: selected.baseProjectId,
                hasAudio: selected.hasAudio,
                createdAt: selected.createdAt,
              };
              onRenameProject(node);
            }}
            onDelete={() => {
              const node: ProjectNode = {
                id: selected.id,
                name: selected.name,
                spaceType: selected.spaceType,
                folderId: selected.folderId,
                baseProjectId: selected.baseProjectId,
                hasAudio: selected.hasAudio,
                createdAt: selected.createdAt,
              };
              onDeleteProject(node);
            }}
            busy={busy}
          />
        )}
      </section>
      )}

      {modal && <ActionModal modal={modal} busy={busy} onClose={() => setModal(null)} />}
    </div>
  );
}

function ProjectDetailPanel({
  project,
  onRename,
  onDelete,
  busy,
}: {
  project: ProjectDetail;
  onRename: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const isWork = project.spaceType === "WORK";
  const rootLabel = project.spaceType === "SHARE" ? "Share Space" : "Work Space";
  return (
    <div>
      <nav className="mb-2 flex items-center gap-1 text-xs text-iron-400 overflow-x-auto">
        <span className="shrink-0">{rootLabel}</span>
        {project.ancestors.map((a) => (
          <span key={a.id} className="flex items-center gap-1 shrink-0">
            <ChevronRight className="w-3 h-3 text-iron-300" />
            <span>{a.name}</span>
          </span>
        ))}
        <ChevronRight className="w-3 h-3 text-iron-300 shrink-0" />
        <span className="text-iron-600 font-medium truncate">{project.name}</span>
      </nav>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {project.baseProjectId && (
              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-iron-100 text-iron-500">Fork</span>
            )}
          </div>
          <h2 className="text-lg font-semibold text-iron-900 truncate">{project.name}</h2>
          <p className="text-xs text-iron-400">생성: {new Date(project.createdAt).toLocaleString("ko-KR")}</p>
        </div>
        {isWork && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onRename}
              disabled={busy}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-iron-600 border border-iron-200 hover:bg-iron-100 disabled:opacity-50"
            >
              <Pencil className="w-3.5 h-3.5" /> 이름 변경
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-red-600 border border-red-200 hover:bg-red-50 disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" /> 삭제
            </button>
          </div>
        )}
      </div>

      {/* 음원 보유 시: 헤더(파일명/다운로드) + 임베드 분석 대시보드 */}
      {project.audio ? (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2 text-sm text-iron-700">
            <FileAudio className="w-4 h-4 text-brand-blue shrink-0" />
            <span className="truncate font-medium">{project.audio.filename}</span>
            <span className="text-xs text-iron-400 shrink-0">
              {(project.audio.sizeBytes / 1024 / 1024).toFixed(2)} MB · {project.audio.mimeType || "audio"}
            </span>
            <a
              href={`/api/projects/${project.id}/audio?download=1`}
              className="ml-auto inline-flex items-center gap-1.5 text-xs text-brand-blue hover:underline"
            >
              <Download className="w-3.5 h-3.5" /> 다운로드
            </a>
          </div>
          {/* 음원별 분석 대시보드 (실시간 추적 / 배치 분석 / 측정) */}
          <ProjectAnalysisPanel key={project.id} project={project} />
        </>
      ) : isWork ? (
        <div className="mt-5 p-4 rounded-xl border border-dashed border-iron-200 text-sm text-iron-400 flex items-center gap-2">
          <FilePlus2 className="w-4 h-4" /> 업로드된 음원이 없습니다.
        </div>
      ) : null}

      <h3 className="mt-6 mb-2 text-sm font-semibold text-iron-700">측정 결과 ({project.measurements.length})</h3>
      {project.measurements.length === 0 ? (
        <p className="text-sm text-iron-300">등록된 측정 결과가 없습니다.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-iron-400 border-b border-iron-100">
              <th className="py-2 font-medium">라벨</th>
              <th className="py-2 font-medium">스피커</th>
              <th className="py-2 font-medium text-right">전력(W)</th>
              <th className="py-2 font-medium text-right">길이(s)</th>
              <th className="py-2 font-medium text-right">프레임</th>
            </tr>
          </thead>
          <tbody>
            {project.measurements.map((m) => (
              <tr key={m.id} className="border-b border-iron-50 last:border-0">
                <td className="py-2 text-iron-900">{m.label}</td>
                <td className="py-2 text-iron-500">{m.speaker ?? "—"}</td>
                <td className="py-2 text-right text-iron-500">{m.powerW ?? "—"}</td>
                <td className="py-2 text-right text-iron-500">{m.durationSec.toFixed(1)}</td>
                <td className="py-2 text-right text-iron-500">{m.frameCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ActionModal({ modal, busy, onClose }: { modal: ModalState; busy: boolean; onClose: () => void }) {
  const [value, setValue] = useState(modal.kind === "prompt" ? modal.value : "");

  const submit = () => {
    if (modal.kind === "prompt") {
      if (!value.trim()) return;
      modal.onConfirm(value.trim());
    } else {
      modal.onConfirm();
    }
    onClose();
  };

  return (
    <Portal>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-iron-900/30" onClick={onClose}>
      <div
        className="w-[22rem] bg-white rounded-xl shadow-xl border border-iron-100 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-iron-900 mb-3">{modal.title}</h3>
        {modal.kind === "prompt" ? (
          <div>
            <label className="block text-xs text-iron-400 mb-1">{modal.label}</label>
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") onClose();
              }}
              className="w-full px-3 py-2 rounded-lg border border-iron-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/40"
            />
          </div>
        ) : (
          <p className="text-sm text-iron-600">{modal.message}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-sm text-iron-500 border border-iron-200 hover:bg-iron-100"
          >
            취소
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || (modal.kind === "prompt" && !value.trim())}
            className={`px-3 py-1.5 rounded-lg text-sm text-white disabled:opacity-50 ${
              modal.kind === "confirm" && modal.danger ? "bg-red-500 hover:bg-red-600" : "bg-brand-blue hover:bg-brand-blue/90"
            }`}
          >
            {modal.confirmText}
          </button>
        </div>
      </div>
    </div>
    </Portal>
  );
}
