"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listWorkspaceItems,
  saveWorkspaceItem,
  renameWorkspaceItem,
  deleteWorkspaceItem,
  getWorkspacePayload,
  type WorkspaceItemMeta,
  type WorkspacePayload,
  type SaveWorkspaceInput,
} from "@/features/audio/lib/cache/workspace";
import { framesToCsv } from "@/features/audio/lib/export/csv";
import { downloadBlob, sanitizeFileName, splitFileName } from "@/shared/lib/utils";
import { useErrorPopup } from "@/shared/components/error-popup/ErrorPopupContext";

async function withWorkspacePayload<T>(
  meta: WorkspaceItemMeta,
  pick: (payload: WorkspacePayload) => T | null | undefined,
  build: (value: T) => Promise<void>,
  operation: string,
  errorMessage: string,
  showError: (message: string) => void,
): Promise<void> {
  let payload;
  try {
    payload = await getWorkspacePayload(meta.id);
  } catch {
    showError(errorMessage);
    return;
  }
  if (!payload) return;
  const value = pick(payload);
  if (!value) return;
  try {
    await build(value);
  } catch (e) {
    console.error(`[useWorkspaceItems] ${operation} save failed:`, e);
    showError(errorMessage);
  }
}

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
    await withWorkspacePayload(
      meta,
      (payload) => payload,
      async (payload) => {
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
        await downloadBlob(
          new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
          `${sanitizeFileName(meta.name)}.json`,
        );
      },
      "exportJson",
      "Failed to export JSON.",
      showError,
    );
  }, [showError]);

  const exportCsv = useCallback(async (meta: WorkspaceItemMeta) => {
    await withWorkspacePayload(
      meta,
      (payload) => payload,
      async (payload) => {
        await downloadBlob(
          new Blob([framesToCsv(payload.frames)], { type: "text/csv;charset=utf-8" }),
          `${sanitizeFileName(meta.name)}.csv`,
        );
      },
      "exportCsv",
      "Failed to export CSV.",
      showError,
    );
  }, [showError]);

  const downloadAudio = useCallback(async (meta: WorkspaceItemMeta) => {
    await withWorkspacePayload(
      meta,
      (payload) => payload.audioBlob,
      async (audioBlob) => {
        const ext = splitFileName(meta.audioFileName).ext || "audio";
        await downloadBlob(audioBlob, `${sanitizeFileName(meta.name)}.${ext}`);
      },
      "downloadAudio",
      "Failed to download audio.",
      showError,
    );
  }, [showError]);

  const downloadProtectedAudio = useCallback(async (meta: WorkspaceItemMeta) => {
    await withWorkspacePayload(
      meta,
      (payload) => payload.protectedAudioBlob,
      async (protectedAudioBlob) => {
        await downloadBlob(protectedAudioBlob, `${sanitizeFileName(meta.name)}-protected.wav`);
      },
      "downloadProtectedAudio",
      "Failed to download protected audio.",
      showError,
    );
  }, [showError]);

  return { items, saveCurrent, rename, remove, exportJson, exportCsv, downloadAudio, downloadProtectedAudio };
}
