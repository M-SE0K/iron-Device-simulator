"use client";

// 폴더에서 파일 고르기 — 대시보드의 SelectedFilePanel 이 여는 Workspace 드로어의 단일 진입점.
// Electron 빌드는 window.localFolder(네이티브 폴더 감시), 그 외 웹/모바일 빌드는
// <input webkitdirectory> 로 폴더를 통째로 업로드해 같은 UX 를 제공한다.
import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Music } from "lucide-react";
import { useWorkspace } from "./WorkspaceContext";
import { cn, formatFileSize } from "@/shared/lib/utils";

// 폴더 안의 오디오 파일 목록 — 항목을 호버하면 강조되고 클릭하면 분석에 로드된다.
// 현재 로드된 파일(activeName)은 파란색으로 선택 표시. Electron/브라우저 공용 렌더러.
interface FolderFile { key: string; name: string; size: number }
function FolderFileList({
  files, activeName, onSelect,
}: {
  files: FolderFile[];
  activeName: string | null;
  onSelect: (key: string) => void;
}) {
  if (files.length === 0) {
    return <p className="px-2.5 py-2 text-[11px] text-iron-400">폴더에 오디오 파일이 없습니다.</p>;
  }
  return (
    <div className="flex flex-col gap-0.5 max-h-48 overflow-auto">
      {files.map((f) => {
        const active = f.name === activeName;
        return (
          <button
            key={f.key}
            type="button"
            onClick={() => onSelect(f.key)}
            title={f.key}
            className={cn(
              "group/file flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-left transition",
              active ? "bg-brand-blue/10" : "hover:bg-iron-50",
            )}
          >
            <Music
              className={cn(
                "w-3.5 h-3.5 shrink-0 transition-colors",
                active ? "text-brand-blue" : "text-iron-300 group-hover/file:text-brand-blue",
              )}
            />
            <span
              className={cn(
                "flex-1 min-w-0 truncate text-xs",
                active ? "text-brand-blue font-medium" : "text-iron-700",
              )}
            >
              {f.name}
            </span>
            <span className="shrink-0 text-[10px] text-iron-300 font-mono">{formatFileSize(f.size)}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function WorkspaceFolderSection() {
  const {
    localFolderPath, localFolderFiles, localFolderError, localFolderConnecting,
    connectLocalFolder, disconnectLocalFolder, loadLocalFile,
    browserFolderName, browserFolderFiles, selectBrowserFolder, disconnectBrowserFolder,
    loadBrowserFile, activeFileName,
  } = useWorkspace();
  const [isElectron, setIsElectron] = useState(false);

  useEffect(() => {
    setIsElectron(typeof window !== "undefined" && !!window.localFolder);
  }, []);

  // webkitdirectory/directory 는 표준 타입에 없어 콜백 ref 로 속성을 직접 설정한다.
  const setDirInput = useCallback((el: HTMLInputElement | null) => {
    if (el) { el.setAttribute("webkitdirectory", ""); el.setAttribute("directory", ""); }
  }, []);

  const header = (path: string | null, onDisconnect: () => void) => (
    <div className="flex items-center justify-between px-2.5 py-1.5">
      <span className="text-[11px] font-semibold text-iron-400 uppercase tracking-wide">폴더</span>
      {path && (
        <button
          type="button"
          onClick={onDisconnect}
          className="text-[10px] text-iron-400 hover:text-red-600 transition"
        >
          연결 해제
        </button>
      )}
    </div>
  );

  const connectedPath = (path: string) => (
    <div className="flex items-center gap-1.5 px-2.5 text-[10px] text-iron-400 font-mono">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
      <span className="truncate" title={path}>{path}</span>
    </div>
  );

  if (isElectron) {
    return (
      <div className="mb-2 pb-2 border-b border-iron-100">
        {header(localFolderPath, disconnectLocalFolder)}
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
            {connectedPath(localFolderPath)}
            <FolderFileList
              files={localFolderFiles.map((f) => ({ key: f.path, name: f.name, size: f.size }))}
              activeName={activeFileName}
              onSelect={(key) => {
                const entry = localFolderFiles.find((f) => f.path === key);
                if (entry) void loadLocalFile(entry);
              }}
            />
          </div>
        )}
        {localFolderError && <p className="px-2.5 pt-1 text-[10px] text-red-500">{localFolderError}</p>}
      </div>
    );
  }

  // 브라우저/모바일 빌드 — webkitdirectory 폴더 업로드
  return (
    <div className="mb-2 pb-2 border-b border-iron-100">
      {header(browserFolderName, disconnectBrowserFolder)}
      <input
        ref={setDirInput}
        type="file"
        multiple
        accept="audio/*"
        className="hidden"
        id="workspace-folder-input"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) selectBrowserFolder(e.target.files);
          e.target.value = ""; // 같은 폴더 재선택 허용
        }}
      />
      {!browserFolderName ? (
        <label
          htmlFor="workspace-folder-input"
          className="mx-2.5 flex w-[calc(100%-1.25rem)] cursor-pointer items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-iron-200 text-xs text-iron-500 hover:border-brand-blue hover:text-brand-blue transition"
        >
          <FolderOpen className="w-3.5 h-3.5" />
          폴더 업로드
        </label>
      ) : (
        <div className="flex flex-col gap-1">
          {connectedPath(browserFolderName)}
          <FolderFileList
            files={browserFolderFiles.map((f) => ({
              key: f.webkitRelativePath || f.name, name: f.name, size: f.size,
            }))}
            activeName={activeFileName}
            onSelect={(key) => {
              const file = browserFolderFiles.find((f) => (f.webkitRelativePath || f.name) === key);
              if (file) loadBrowserFile(file);
            }}
          />
        </div>
      )}
    </div>
  );
}
