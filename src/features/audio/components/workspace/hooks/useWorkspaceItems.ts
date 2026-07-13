"use client";

// 워크스페이스 항목 CRUD + export — WorkspaceContext가 조합하는 훅 중 하나.
// 영속화는 lib/cache/workspace.ts(IndexedDB)가 담당하고, 이 훅은 그 위의 목록 상태 + 액션만 감싼다.
import { useCallback, useEffect, useState } from "react";
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

/** 파일명에서 확장자만 추출 (없으면 ""). export 시 편집한 이름 + 원본 확장자 조합에 사용 */
function fileExtension(fileName: string | null): string {
  if (!fileName) return "";
  const dot = fileName.lastIndexOf(".");
  return dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot + 1) : "";
}

export function useWorkspaceItems(onSaved: () => void) {
  const [items, setItems] = useState<WorkspaceItemMeta[]>([]);

  const refresh = useCallback(async () => {
    setItems(await listWorkspaceItems());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveCurrent = useCallback(async (input: SaveWorkspaceInput) => {
    await saveWorkspaceItem(input);
    await refresh();
    onSaved();
  }, [refresh, onSaved]);

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
    // 편집한 기록 이름(meta.name)을 파일명으로 쓰되, 확장자는 원본 오디오 파일명에서 보존한다.
    const ext = fileExtension(meta.audioFileName) || "audio";
    downloadBlob(payload.audioBlob, `${sanitizeFileName(meta.name)}.${ext}`);
  }, []);

  return { items, saveCurrent, rename, remove, exportJson, exportCsv, downloadAudio };
}
