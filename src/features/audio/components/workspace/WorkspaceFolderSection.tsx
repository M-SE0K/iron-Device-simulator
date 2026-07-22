"use client";

// 폴더에서 파일 고르기 — Workspace 드로어의 본문. 연결된 폴더의 오디오 파일을
// "폴더 → 파일" 트리(L자 커넥터 + 크기 표시)로 보여준다. 현재 로드된 파일은 하이라이트.
// Electron 빌드는 window.localFolder(네이티브 폴더 감시), 그 외 웹/모바일 빌드는
// <input webkitdirectory> 로 폴더를 통째로 업로드해 같은 UX 를 제공한다.
import { useCallback, useEffect, useState } from "react";
import { Folder, FileText, FolderOpen } from "lucide-react";
import { useWorkspace } from "./WorkspaceContext";
import { cn, formatFileSize, splitPath } from "@/shared/lib/utils";
import CountBadge from "@/shared/components/ui/CountBadge";

interface FolderFile { key: string; name: string; size: number }

// 이미지의 파일 트리 — 폴더 행 + L자 커넥터 + 파일 행(이름/크기)
function FolderTree({
  folderName, folderPath, files, activeName, onSelect,
}: {
  folderName: string;
  folderPath: string;
  files: FolderFile[];
  activeName: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="flex flex-col">
      {/* 폴더 행 */}
      <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-iron-100">
        <Folder className="w-4 h-4 shrink-0 text-brand-blue fill-brand-blue" />
        <span className="flex-1 min-w-0 truncate text-sm font-bold text-iron-900">{folderName}</span>
        {folderPath && (
          <span className="shrink-0 max-w-[45%] truncate text-xs font-medium text-iron-400" title={folderPath}>
            {folderPath}
          </span>
        )}
      </div>

      {/* 파일 트리 — 폴더 아이콘 중심 아래로 세로 트렁크 + 각 파일 L자 커넥터 */}
      {files.length === 0 ? (
        <p className="pl-7 pt-2 text-xs text-iron-400">폴더에 오디오 파일이 없습니다.</p>
      ) : (
        <div className="ml-[19px] mt-1 flex flex-col border-l border-iron-200">
          {files.map((f) => {
            const active = f.name === activeName;
            return (
              <div key={f.key} className="relative pl-3.5">
                <span aria-hidden className="absolute left-0 top-1/2 h-px w-3 bg-iron-200" />
                <button
                  type="button"
                  onClick={() => onSelect(f.key)}
                  title={f.key}
                  className={cn(
                    "group/file my-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition",
                    active ? "bg-brand-blue/10" : "hover:bg-iron-50",
                  )}
                >
                  <FileText
                    className={cn(
                      "w-4 h-4 shrink-0 transition-colors",
                      active ? "text-brand-blue" : "text-iron-300 group-hover/file:text-iron-500",
                    )}
                  />
                  <span
                    className={cn(
                      "flex-1 min-w-0 truncate text-sm",
                      active ? "font-semibold text-brand-blue" : "text-iron-700",
                    )}
                  >
                    {f.name}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-xs font-medium tabular-nums",
                      active ? "text-brand-blue/70" : "text-iron-300",
                    )}
                  >
                    {formatFileSize(f.size)}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
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
    if (el) {
      el.setAttribute("webkitdirectory", "");
      el.setAttribute("directory", "");
    }
  }, []);

  // "폴더" 섹션 헤더 — 좌: 라벨, 우: 연결 시 파일 개수(초록 점) + 해제
  const header = (connected: boolean, count: number, onDisconnect: () => void) => (
    <div className="flex items-center justify-between px-1 pb-2">
      <span className="text-sm font-medium text-iron-400">폴더</span>
      {connected && (
        <div className="flex items-center gap-2">
          <CountBadge count={count} suffix="개 파일" />
          <button
            type="button"
            onClick={onDisconnect}
            className="text-xs text-iron-300 hover:text-red-500 transition"
          >
            해제
          </button>
        </div>
      )}
    </div>
  );

  if (isElectron) {
    const connected = !!localFolderPath;
    const { name, parent } = connected ? splitPath(localFolderPath!) : { name: "", parent: "" };
    return (
      <div>
        {header(connected, localFolderFiles.length, disconnectLocalFolder)}
        {!connected ? (
          <button
            type="button"
            onClick={() => void connectLocalFolder()}
            disabled={localFolderConnecting}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-iron-200 px-3 py-3 text-xs text-iron-500 transition hover:border-brand-blue hover:text-brand-blue disabled:opacity-50"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            {localFolderConnecting ? "연결 중..." : "폴더 연결"}
          </button>
        ) : (
          <FolderTree
            folderName={name}
            folderPath={parent}
            files={localFolderFiles.map((f) => ({ key: f.path, name: f.name, size: f.size }))}
            activeName={activeFileName}
            onSelect={(key) => {
              const entry = localFolderFiles.find((f) => f.path === key);
              if (entry) void loadLocalFile(entry);
            }}
          />
        )}
        {localFolderError && <p className="px-1 pt-2 text-[10px] text-red-500">{localFolderError}</p>}
      </div>
    );
  }

  // 브라우저/모바일 빌드 — webkitdirectory 폴더 업로드
  const connected = !!browserFolderName;
  return (
    <div>
      {header(connected, browserFolderFiles.length, disconnectBrowserFolder)}
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
      {!connected ? (
        <label
          htmlFor="workspace-folder-input"
          className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-dashed border-iron-200 px-3 py-3 text-xs text-iron-500 transition hover:border-brand-blue hover:text-brand-blue"
        >
          <FolderOpen className="w-3.5 h-3.5" />
          폴더 업로드
        </label>
      ) : (
        <FolderTree
          folderName={browserFolderName!}
          folderPath=""
          files={browserFolderFiles.map((f) => ({
            key: f.webkitRelativePath || f.name, name: f.name, size: f.size,
          }))}
          activeName={activeFileName}
          onSelect={(key) => {
            const file = browserFolderFiles.find((f) => (f.webkitRelativePath || f.name) === key);
            if (file) loadBrowserFile(file);
          }}
        />
      )}
    </div>
  );
}
