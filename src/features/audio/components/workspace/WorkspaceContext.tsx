"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useWorkspaceItems } from "./hooks/useWorkspaceItems";
import { useLocalFolderConnection } from "./hooks/useLocalFolderConnection";
import { useBrowserFolderUpload } from "./hooks/useBrowserFolderUpload";
import { useActiveDrawer } from "@/features/audio/components/dashboard/ActiveDrawerContext";
import type { WorkspaceItemMeta, SaveWorkspaceInput } from "@/features/audio/lib/cache/workspace";
import type { LocalAudioFileEntry } from "@/features/audio/lib/local-folder";

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
  downloadProtectedAudio: (meta: WorkspaceItemMeta) => Promise<void>;
  localFolderPath: string | null;
  localFolderFiles: LocalAudioFileEntry[];
  localFolderError: string | null;
  localFolderConnecting: boolean;
  connectLocalFolder: () => Promise<void>;
  disconnectLocalFolder: () => void;
  loadLocalFile: (entry: LocalAudioFileEntry) => Promise<void>;
  browserFolderName: string | null;
  browserFolderFiles: File[];
  selectBrowserFolder: (files: FileList | File[]) => void;
  disconnectBrowserFolder: () => void;
  loadBrowserFile: (file: File) => void;
  activeFileName: string | null;
  pendingLocalFile: File | null;
  clearPendingLocalFile: () => void;
}

const Ctx = createContext<WorkspaceCtx | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const activeDrawer = useActiveDrawer();
  const open = activeDrawer.active === "workspace";
  const setOpen = useCallback(
    (v: boolean) => (v ? activeDrawer.openDrawer("workspace") : activeDrawer.closeDrawer()),
    [activeDrawer],
  );

  const { items, saveCurrent, rename, remove, exportJson, exportCsv, downloadAudio, downloadProtectedAudio } =
    useWorkspaceItems(() => activeDrawer.openDrawer("records"));

  const [pendingLocalFile, setPendingLocalFile] = useState<File | null>(null);
  const [activeFileName, setActiveFileName]     = useState<string | null>(null);
  const onFileLoad = useCallback((file: File, name: string) => {
    setPendingLocalFile(file);
    setActiveFileName(name);
  }, []);
  const clearPendingLocalFile = useCallback(() => setPendingLocalFile(null), []);

  const {
    localFolderPath, localFolderFiles, localFolderError, localFolderConnecting,
    connectLocalFolder, disconnectLocalFolder, loadLocalFile,
  } = useLocalFolderConnection(onFileLoad);

  const {
    browserFolderName, browserFolderFiles, selectBrowserFolder, disconnectBrowserFolder, loadBrowserFile,
  } = useBrowserFolderUpload(onFileLoad);

  const ctx = useMemo<WorkspaceCtx>(
    () => ({
      items, open, setOpen, saveCurrent, rename, remove, exportJson, exportCsv, downloadAudio, downloadProtectedAudio,
      localFolderPath, localFolderFiles, localFolderError, localFolderConnecting,
      connectLocalFolder, disconnectLocalFolder, loadLocalFile,
      browserFolderName, browserFolderFiles, selectBrowserFolder, disconnectBrowserFolder,
      loadBrowserFile, activeFileName,
      pendingLocalFile, clearPendingLocalFile,
    }),
    [
      items, open, saveCurrent, rename, remove, exportJson, exportCsv, downloadAudio, downloadProtectedAudio,
      localFolderPath, localFolderFiles, localFolderError, localFolderConnecting,
      connectLocalFolder, disconnectLocalFolder, loadLocalFile,
      browserFolderName, browserFolderFiles, selectBrowserFolder, disconnectBrowserFolder,
      loadBrowserFile, activeFileName,
      pendingLocalFile, clearPendingLocalFile,
    ],
  );

  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
