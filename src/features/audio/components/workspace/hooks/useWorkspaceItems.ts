"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listWorkspaceItems,
  saveWorkspaceItem,
  renameWorkspaceItem,
  deleteWorkspaceItem,
  getWorkspacePayload,
  type WorkspaceItemMeta,
  type SaveWorkspaceInput,
} from "@/features/audio/lib/cache/workspace";
import { framesToCsv } from "@/features/audio/lib/export/csv";
import { downloadBlob, sanitizeFileName, splitFileName } from "@/shared/lib/utils";

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
    const ext = splitFileName(meta.audioFileName).ext || "audio";
    downloadBlob(payload.audioBlob, `${sanitizeFileName(meta.name)}.${ext}`);
  }, []);

  const downloadProtectedAudio = useCallback(async (meta: WorkspaceItemMeta) => {
    const payload = await getWorkspacePayload(meta.id);
    if (!payload?.protectedAudioBlob) return;
    downloadBlob(payload.protectedAudioBlob, `${sanitizeFileName(meta.name)}-protected.wav`);
  }, []);

  return { items, saveCurrent, rename, remove, exportJson, exportCsv, downloadAudio, downloadProtectedAudio };
}
