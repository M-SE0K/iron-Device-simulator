"use client";

// 휴지통(soft delete) 목록 + 복원 — WorkspaceTree.tsx 에서 오버레이로 렌더 (설계: docs/02 §7)
import { useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { Loader2, RotateCcw, Folder as FolderIcon, FileAudio, X } from "lucide-react";
import type { SpaceTypeT, TrashListResponse } from "@/features/workspace/types";

interface TrashPanelProps {
  space: SpaceTypeT;
  onClose: () => void;
  /** 복원 성공 시 호출 — 원래 있던 위치(parentKey, 루트면 null)의 트리 캐시를 갱신하도록 알림 */
  onRestored: (space: SpaceTypeT, parentKey: string | null) => void;
}

export default function TrashPanel({ space, onClose, onRestored }: TrashPanelProps) {
  const [data, setData] = useState<TrashListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  // 드로어(transform) 컨테이닝 블록을 벗어나 화면 중앙에 렌더하기 위해 body 로 포털
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/trash?space=${space}`);
      if (!res.ok) throw new Error("휴지통을 불러오지 못했습니다.");
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "휴지통을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [space]);

  useEffect(() => {
    load();
  }, [load]);

  const restoreFolder = async (id: string, parentId: string | null) => {
    setRestoringId(id);
    try {
      const res = await fetch(`/api/folders/${id}/restore`, { method: "POST" });
      if (!res.ok) throw new Error("복원에 실패했습니다.");
      setData((prev) => (prev ? { ...prev, folders: prev.folders.filter((f) => f.id !== id) } : prev));
      onRestored(space, parentId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "복원에 실패했습니다.");
    } finally {
      setRestoringId(null);
    }
  };

  const restoreProject = async (id: string, folderId: string) => {
    setRestoringId(id);
    try {
      const res = await fetch(`/api/projects/${id}/restore`, { method: "POST" });
      if (!res.ok) throw new Error("복원에 실패했습니다.");
      setData((prev) => (prev ? { ...prev, projects: prev.projects.filter((p) => p.id !== id) } : prev));
      onRestored(space, folderId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "복원에 실패했습니다.");
    } finally {
      setRestoringId(null);
    }
  };

  const isEmpty = data && data.folders.length === 0 && data.projects.length === 0;

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-iron-900/30" onClick={onClose}>
      <div
        className="w-[26rem] max-h-[70vh] flex flex-col bg-white rounded-xl shadow-xl border border-iron-100 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-iron-900">
            휴지통 · {space === "SHARE" ? "Share Space" : "내 Work Space"}
          </h3>
          <button type="button" onClick={onClose} className="text-iron-400 hover:text-iron-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && <div className="mb-2 px-2 py-1.5 rounded-md bg-red-50 text-red-600 text-xs">{error}</div>}

        <div className="flex-1 overflow-auto -mx-1 px-1">
          {loading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-iron-400">
              <Loader2 className="w-4 h-4 animate-spin" /> 불러오는 중…
            </div>
          ) : isEmpty ? (
            <div className="p-4 text-xs text-iron-300">휴지통이 비어 있습니다.</div>
          ) : (
            <div>
              {data!.folders.map((f) => (
                <div key={f.id} className="flex items-center gap-2 px-2 py-2 rounded-md hover:bg-iron-50">
                  <FolderIcon className="w-4 h-4 text-iron-300 shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-sm text-iron-600">{f.name}</span>
                  <button
                    type="button"
                    disabled={restoringId === f.id}
                    onClick={() => restoreFolder(f.id, f.parentId)}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-brand-blue border border-brand-blue/30 hover:bg-brand-blue/5 disabled:opacity-50 shrink-0"
                  >
                    <RotateCcw className="w-3.5 h-3.5" /> 복원
                  </button>
                </div>
              ))}
              {data!.projects.map((p) => (
                <div key={p.id} className="flex items-center gap-2 px-2 py-2 rounded-md hover:bg-iron-50">
                  <FileAudio className="w-4 h-4 text-iron-300 shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-sm text-iron-600">{p.name}</span>
                  <button
                    type="button"
                    disabled={restoringId === p.id}
                    onClick={() => restoreProject(p.id, p.folderId)}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-brand-blue border border-brand-blue/30 hover:bg-brand-blue/5 disabled:opacity-50 shrink-0"
                  >
                    <RotateCcw className="w-3.5 h-3.5" /> 복원
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
