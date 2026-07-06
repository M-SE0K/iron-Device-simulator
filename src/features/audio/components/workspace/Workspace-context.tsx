"use client";

// 작업 영역(Workspace) 단일 소스 (앱 전역 Context) — VSCode 워크스페이스 참고.
// 대시보드 "저장" 버튼(DashboardClient)과 좌측 드로어(WorkspaceDrawer)가 같은 목록을 공유한다.
// 실제 영속화는 lib/cache/workspace.ts(IndexedDB)가 담당하며, 이 Context는 목록 상태 +
// 드로어 open 상태 + CRUD/내보내기 액션만 감싼다.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  listWorkspaceItems,
  saveWorkspaceItem,
  renameWorkspaceItem,
  deleteWorkspaceItem,
  getWorkspacePayload,
  framesToCsv,
  sanitizeFileName,
  type WorkspaceItemMeta,
  type SaveWorkspaceInput,
} from "@/features/audio/lib/cache/workspace";
import { downloadBlob } from "@/shared/lib/utils";

interface WorkspaceCtx {
  items: WorkspaceItemMeta[];
  open: boolean;
  setOpen: (v: boolean) => void;
  saveCurrent: (input: SaveWorkspaceInput) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  exportJson: (meta: WorkspaceItemMeta) => Promise<void>;
  exportCsv: (meta: WorkspaceItemMeta) => Promise<void>;
  downloadAudio: (meta: WorkspaceItemMeta) => Promise<void>;
}

const Ctx = createContext<WorkspaceCtx | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<WorkspaceItemMeta[]>([]);
  const [open, setOpen]   = useState(false);

  const refresh = useCallback(async () => {
    setItems(await listWorkspaceItems());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveCurrent = useCallback(async (input: SaveWorkspaceInput) => {
    await saveWorkspaceItem(input);
    await refresh();
    setOpen(true);
  }, [refresh]);

  const rename = useCallback(async (id: string, name: string) => {
    await renameWorkspaceItem(id, name);
    await refresh();
  }, [refresh]);

  const remove = useCallback(async (id: string) => {
    await deleteWorkspaceItem(id);
    await refresh();
  }, [refresh]);

  const exportJson = useCallback(async (meta: WorkspaceItemMeta) => {
    const payload = await getWorkspacePayload(meta.id);
    if (!payload) return;
    const data = {
      meta: {
        name:          meta.name,
        audioFileName: meta.audioFileName,
        audioDuration: meta.audioDuration,
        analysisMode:  meta.analysisMode,
        createdAt:     new Date(meta.createdAt).toISOString(),
        frameCount:    meta.frameCount,
      },
      frames: payload.frames,
    };
    downloadBlob(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      `${sanitizeFileName(meta.name)}.json`,
    );
  }, []);

  const exportCsv = useCallback(async (meta: WorkspaceItemMeta) => {
    const payload = await getWorkspacePayload(meta.id);
    if (!payload) return;
    downloadBlob(
      new Blob([framesToCsv(payload.frames)], { type: "text/csv;charset=utf-8" }),
      `${sanitizeFileName(meta.name)}.csv`,
    );
  }, []);

  const downloadAudio = useCallback(async (meta: WorkspaceItemMeta) => {
    const payload = await getWorkspacePayload(meta.id);
    if (!payload?.audioBlob) return;
    downloadBlob(payload.audioBlob, meta.audioFileName ?? `${sanitizeFileName(meta.name)}.audio`);
  }, []);

  const ctx = useMemo<WorkspaceCtx>(
    () => ({ items, open, setOpen, saveCurrent, rename, remove, exportJson, exportCsv, downloadAudio }),
    [items, open, saveCurrent, rename, remove, exportJson, exportCsv, downloadAudio],
  );

  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
