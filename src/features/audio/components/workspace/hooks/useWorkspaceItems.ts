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
import { useErrorPopup } from "@/shared/components/error-popup/ErrorPopupContext";

export function useWorkspaceItems(onSaved: () => void) {
  const { showError } = useErrorPopup();
  const [items, setItems] = useState<WorkspaceItemMeta[]>([]);

  const refresh = useCallback(async () => {
    try {
      setItems(await listWorkspaceItems());
    } catch {
      showError("Failed to load saved items.");
    }
  }, [showError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveCurrent = useCallback(async (input: SaveWorkspaceInput) => {
    try {
      await saveWorkspaceItem(input);
    } catch {
      showError("Failed to save to Workspace.");
      return;
    }
    await refresh();
    onSaved();
  }, [refresh, onSaved, showError]);

  const rename = useCallback(async (id: string, name: string) => {
    try {
      await renameWorkspaceItem(id, name);
    } catch {
      showError("Failed to rename item.");
      return;
    }
    await refresh();
  }, [refresh, showError]);

  const remove = useCallback(async (id: string) => {
    try {
      await deleteWorkspaceItem(id);
    } catch {
      showError("Failed to delete item.");
      return;
    }
    await refresh();
  }, [refresh, showError]);

  const exportJson = useCallback(async (meta: WorkspaceItemMeta) => {
    let payload;
    try {
      payload = await getWorkspacePayload(meta.id);
    } catch {
      showError("Failed to export JSON.");
      return;
    }
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
    try {
      await downloadBlob(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
        `${sanitizeFileName(meta.name)}.json`,
      );
    } catch (e) {
      console.error("[useWorkspaceItems] exportJson save failed:", e);
      showError("Failed to export JSON.");
    }
  }, [showError]);

  const exportCsv = useCallback(async (meta: WorkspaceItemMeta) => {
    let payload;
    try {
      payload = await getWorkspacePayload(meta.id);
    } catch {
      showError("Failed to export CSV.");
      return;
    }
    if (!payload) return;
    try {
      await downloadBlob(
        new Blob([framesToCsv(payload.frames)], { type: "text/csv;charset=utf-8" }),
        `${sanitizeFileName(meta.name)}.csv`,
      );
    } catch (e) {
      console.error("[useWorkspaceItems] exportCsv save failed:", e);
      showError("Failed to export CSV.");
    }
  }, [showError]);

  const downloadAudio = useCallback(async (meta: WorkspaceItemMeta) => {
    let payload;
    try {
      payload = await getWorkspacePayload(meta.id);
    } catch {
      showError("Failed to download audio.");
      return;
    }
    if (!payload?.audioBlob) return;
    const ext = splitFileName(meta.audioFileName).ext || "audio";
    try {
      await downloadBlob(payload.audioBlob, `${sanitizeFileName(meta.name)}.${ext}`);
    } catch (e) {
      console.error("[useWorkspaceItems] downloadAudio save failed:", e);
      showError("Failed to download audio.");
    }
  }, [showError]);

  const downloadProtectedAudio = useCallback(async (meta: WorkspaceItemMeta) => {
    let payload;
    try {
      payload = await getWorkspacePayload(meta.id);
    } catch {
      showError("Failed to download protected audio.");
      return;
    }
    if (!payload?.protectedAudioBlob) return;
    try {
      await downloadBlob(payload.protectedAudioBlob, `${sanitizeFileName(meta.name)}-protected.wav`);
    } catch (e) {
      console.error("[useWorkspaceItems] downloadProtectedAudio save failed:", e);
      showError("Failed to download protected audio.");
    }
  }, [showError]);

  return { items, saveCurrent, rename, remove, exportJson, exportCsv, downloadAudio, downloadProtectedAudio };
}
