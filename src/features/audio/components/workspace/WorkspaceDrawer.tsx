"use client";

// 좌측 슬라이딩 드로어 — 저장된 세션(음원 + 분석 그래프) 작업 영역. VSCode 워크스페이스 참고.
// 대시보드 "저장" 버튼(DashboardClient.handleSaveToWorkspace)이 세션을 추가하면 이 드로어가
// 자동으로 열린다(workspace-context.saveCurrent). 목록 항목은 더블클릭 또는 연필 아이콘으로
// 이름을 바로 수정할 수 있고, JSON/CSV/오디오 원본을 각각 다운로드할 수 있다.
import { useEffect, useRef, useState } from "react";
import { FolderOpen, Menu, Music, Pencil, Save, Trash2, X } from "lucide-react";
import { useWorkspace } from "./Workspace-context";
import { formatTime } from "@/shared/lib/utils";
import type { WorkspaceItemMeta } from "@/features/audio/lib/cache/workspace";

function formatFileSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// Electron 데스크톱 빌드에서만 존재(electron/preload.js) — 브라우저/개발서버에서는 숨긴다.
// 하이드레이션 불일치를 피하려 CalibrationDrawer의 audioDevice 감지와 동일하게 마운트 후 감지한다.
function LocalFolderSection() {
  const {
    localFolderPath, localFolderFiles, localFolderError, localFolderConnecting,
    connectLocalFolder, disconnectLocalFolder, loadLocalFile,
  } = useWorkspace();
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    setAvailable(typeof window !== "undefined" && !!window.localFolder);
  }, []);

  if (!available) return null;

  return (
    <div className="mb-2 pb-2 border-b border-iron-100">
      <div className="flex items-center justify-between px-2.5 py-1.5">
        <span className="text-[11px] font-semibold text-iron-400 uppercase tracking-wide">로컬 폴더</span>
        {localFolderPath && (
          <button
            type="button"
            onClick={disconnectLocalFolder}
            className="text-[10px] text-iron-400 hover:text-red-600 transition"
          >
            연결 해제
          </button>
        )}
      </div>

      {!localFolderPath ? (
        <button
          type="button"
          onClick={() => void connectLocalFolder()}
          disabled={localFolderConnecting}
          className="mx-2.5 flex w-[calc(100%-1.25rem)] items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-iron-200 text-xs text-iron-500 hover:border-brand-blue hover:text-brand-blue transition disabled:opacity-50"
        >
          <FolderOpen className="w-3.5 h-3.5" />
          {localFolderConnecting ? "연결 중..." : "폴더 연결"}
        </button>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 px-2.5 text-[10px] text-iron-400 font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
            <span className="truncate" title={localFolderPath}>{localFolderPath}</span>
          </div>
          {localFolderFiles.length === 0 ? (
            <p className="px-2.5 py-2 text-[11px] text-iron-400">폴더에 오디오 파일이 없습니다.</p>
          ) : (
            <div className="flex flex-col gap-0.5 max-h-48 overflow-auto">
              {localFolderFiles.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => void loadLocalFile(f)}
                  title={f.path}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-iron-50 text-left transition"
                >
                  <Music className="w-3.5 h-3.5 text-iron-300 shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-xs text-iron-700">{f.name}</span>
                  <span className="shrink-0 text-[10px] text-iron-300 font-mono">{formatFileSize(f.size)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {localFolderError && <p className="px-2.5 pt-1 text-[10px] text-red-500">{localFolderError}</p>}
    </div>
  );
}

function ItemRow({ item }: { item: WorkspaceItemMeta }) {
  const { rename, remove, exportJson, exportCsv, downloadAudio } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(item.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed && trimmed !== item.name) void rename(item.id, trimmed);
    else setDraft(item.name);
  };

  return (
    <div className="group flex flex-col gap-1.5 px-2.5 py-2 rounded-lg hover:bg-iron-50 transition">
      <div className="flex items-center gap-1.5 min-w-0">
        <Music className="w-3.5 h-3.5 text-iron-300 shrink-0" />
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") { setDraft(item.name); setEditing(false); }
            }}
            autoFocus
            className="flex-1 min-w-0 px-1.5 py-0.5 rounded border border-brand-blue bg-white text-xs font-mono text-iron-800 focus:outline-none"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={() => setEditing(true)}
            title="더블클릭하여 이름 변경"
            className="flex-1 min-w-0 truncate text-left text-xs font-medium text-iron-800"
          >
            {item.name}
          </button>
        )}
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label="이름 변경"
          className="shrink-0 opacity-0 group-hover:opacity-100 p-1 rounded text-iron-300 hover:text-iron-700 hover:bg-iron-100 transition"
        >
          <Pencil className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={() => remove(item.id)}
          aria-label="삭제"
          className="shrink-0 opacity-0 group-hover:opacity-100 p-1 rounded text-iron-300 hover:text-red-600 hover:bg-red-50 transition"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-5 text-[10px] text-iron-400 font-mono">
        <span>{new Date(item.createdAt).toLocaleString()}</span>
        {item.audioDuration != null && <span>· {formatTime(item.audioDuration)}</span>}
        <span>· {item.analysisMode === "batch" ? "분석" : "실시간"}</span>
        <span>· {item.frameCount}fr</span>
      </div>

      <div className="flex items-center gap-1.5 pl-5">
        <button
          type="button"
          onClick={() => exportJson(item)}
          className="px-1.5 py-0.5 rounded border border-iron-200 text-[10px] text-iron-500 hover:border-iron-400 hover:text-iron-800 transition"
        >
          JSON
        </button>
        <button
          type="button"
          onClick={() => exportCsv(item)}
          className="px-1.5 py-0.5 rounded border border-iron-200 text-[10px] text-iron-500 hover:border-iron-400 hover:text-iron-800 transition"
        >
          CSV
        </button>
        {item.audioFileName && (
          <button
            type="button"
            onClick={() => downloadAudio(item)}
            className="px-1.5 py-0.5 rounded border border-iron-200 text-[10px] text-iron-500 hover:border-iron-400 hover:text-iron-800 transition"
          >
            오디오
          </button>
        )}
      </div>
    </div>
  );
}

export default function WorkspaceDrawer() {
  const { items, open, setOpen } = useWorkspace();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  return (
    <>
      {/* 트리거 (좌측) */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="작업 영역 열기"
        aria-expanded={open}
        className="flex items-center gap-1.5 px-3 h-9 rounded-lg hover:bg-iron-100 hover:text-iron-900 transition"
      >
        <Menu className="w-4 h-4" />
        {items.length > 0 && (
          <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-iron-100 text-[10px] text-iron-500 font-mono">
            {items.length}
          </span>
        )}
      </button>

      {/* 배경 오버레이 */}
      <div
        onClick={() => setOpen(false)}
        aria-hidden
        className={`fixed inset-0 z-40 bg-iron-900/30 backdrop-blur-[1px] transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />

      {/* 좌측 슬라이딩 패널 */}
      <aside
        className={`fixed top-0 left-0 z-50 h-full w-80 max-w-[92vw] bg-white border-r border-iron-100 shadow-xl flex flex-col transition-transform duration-300 ease-out ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        role="dialog"
        aria-label="작업 영역"
        aria-hidden={!open}
      >
        <div className="h-14 px-4 shrink-0 flex items-center justify-between border-b border-iron-100">
          <div className="flex items-center gap-2 min-w-0">
            <Menu className="w-4 h-4 text-brand-blue shrink-0" />
            <span className="text-sm font-semibold text-iron-900">Workspace</span>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="닫기"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-iron-400 hover:bg-iron-100 hover:text-iron-700 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-2">
          <LocalFolderSection />
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6">
              <Save className="w-6 h-6 text-iron-200" />
              <p className="text-xs text-iron-400 leading-relaxed">
                대시보드의 저장 버튼을 누르면
                <br />
                음원과 분석 결과가 여기에 보존됩니다.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {items.map((item) => (
                <ItemRow key={item.id} item={item} />
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
