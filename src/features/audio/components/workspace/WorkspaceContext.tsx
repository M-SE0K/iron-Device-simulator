"use client";

// 작업 영역(Workspace) 단일 소스 (앱 전역 Context)
// 대시보드 "저장" 버튼(DashboardClient)과 좌측 드로어(WorkspaceDrawer)가 같은 목록을 공유한다.
// 실제 절차는 hooks/(useWorkspaceItems·useLocalFolderConnection·useBrowserFolderUpload)로 갈라져 있고,
// 이 Context는 그것들을 조합해 값을 노출하는 역할만 한다(calibration/ CalibrationContext와 동일한 분리 패턴).
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
  // 로컬 폴더 연결(Electron 데스크톱 전용) — 폴더 선택/감시는 electron/main.js가 담당하고
  // 여기서는 그 결과 상태만 들고 있는다. pendingLocalFile은 DashboardClient가 소비해
  // 기존 handleFileSelected(File) 파이프라인에 그대로 흘려보낸다.
  localFolderPath: string | null;
  localFolderFiles: LocalAudioFileEntry[];
  localFolderError: string | null;
  localFolderConnecting: boolean;
  connectLocalFolder: () => Promise<void>;
  disconnectLocalFolder: () => void;
  loadLocalFile: (entry: LocalAudioFileEntry) => Promise<void>;
  // 브라우저(웹/모바일) 폴더 업로드 — <input webkitdirectory>. Electron localFolder 가
  // 없는 빌드에서 같은 "폴더에서 파일 고르기" UX 를 제공한다. File 을 직접 들고 있으므로
  // 별도 IPC 읽기 없이 loadBrowserFile 이 pendingLocalFile 로 바로 흘려보낸다.
  browserFolderName: string | null;
  browserFolderFiles: File[];
  selectBrowserFolder: (files: FileList | File[]) => void;
  disconnectBrowserFolder: () => void;
  loadBrowserFile: (file: File) => void;
  // 마지막으로 로드한(=현재 분석 중인) 파일 이름 — 폴더 목록에서 선택 항목 하이라이트용
  activeFileName: string | null;
  pendingLocalFile: File | null;
  clearPendingLocalFile: () => void;
}

const Ctx = createContext<WorkspaceCtx | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  // 우측 드로어 슬롯(Workspace/측정 기록/Calibration)은 ActiveDrawerContext가 배타적으로 관리한다 —
  // open/setOpen은 그 위의 파생값일 뿐이다. 외부 호출부(SelectedFilePanel 등)는 이전과 동일하게
  // setOpen(true|false) 리터럴만 호출하므로 시그니처는 그대로 유지된다.
  const activeDrawer = useActiveDrawer();
  const open = activeDrawer.active === "workspace";
  const setOpen = useCallback(
    (v: boolean) => (v ? activeDrawer.openDrawer("workspace") : activeDrawer.closeDrawer()),
    [activeDrawer],
  );

  const { items, saveCurrent, rename, remove, exportJson, exportCsv, downloadAudio } =
    useWorkspaceItems(() => setOpen(true));

  // 로컬/브라우저 두 폴더 소스가 공유하는 다리 상태 — 어느 쪽에서 로드하든 DashboardClient의
  // 기존 handleFileSelected(File) 파이프라인으로 그대로 흘려보낸다.
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
      items, open, setOpen, saveCurrent, rename, remove, exportJson, exportCsv, downloadAudio,
      localFolderPath, localFolderFiles, localFolderError, localFolderConnecting,
      connectLocalFolder, disconnectLocalFolder, loadLocalFile,
      browserFolderName, browserFolderFiles, selectBrowserFolder, disconnectBrowserFolder,
      loadBrowserFile, activeFileName,
      pendingLocalFile, clearPendingLocalFile,
    }),
    [
      items, open, saveCurrent, rename, remove, exportJson, exportCsv, downloadAudio,
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
