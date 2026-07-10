"use client";

// 우측 슬라이딩 드로어(사이드바 "Workspace" 내비) — 연결된 폴더의 오디오 파일을
// "폴더 → 파일" 트리로 보여주는 파일 브라우저다(파일 선택 → 분석 로드). 저장된 측정
// 세션의 CRUD/export 는 "측정 기록"(RecordsDrawer)으로 이전됐다.
// 트리거는 Sidebar 가 담당(여기는 패널만).
import { X } from "lucide-react";
import { useWorkspace } from "./WorkspaceContext";
import WorkspaceFolderSection from "./WorkspaceFolderSection";
import { useEscapeKey } from "@/shared/hooks/useEscapeKey";

export default function WorkspaceDrawer() {
  const { open, setOpen, localFolderFiles, browserFolderFiles } = useWorkspace();
  // 활성 폴더 소스는 빌드당 하나(Electron localFolder ↔ 브라우저 업로드)라 합계 = 현재 파일 수.
  const fileCount = localFolderFiles.length + browserFolderFiles.length;

  useEscapeKey(() => setOpen(false), open);

  return (
    <>
      {/* 배경 오버레이 — content-column 기준 */}
      <div
        onClick={() => setOpen(false)}
        aria-hidden
        className={`absolute inset-0 z-40 bg-iron-900/30 backdrop-blur-[1px] transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />

      {/* 우측 슬라이딩 패널 */}
      <aside
        className={`absolute top-0 right-0 z-50 h-full w-[320px] max-w-[82vw] bg-white border-l border-iron-100 shadow-[-12px_0_40px_rgba(15,23,42,0.16)] flex flex-col transition-transform duration-[240ms] ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        role="dialog"
        aria-label="작업 영역"
        aria-hidden={!open}
      >
        <div className="px-5 pt-5 pb-4 shrink-0 flex items-center justify-between border-b border-iron-100">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="m-0 text-lg font-bold text-iron-900">Workspace</h2>
            {fileCount > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-iron-100 text-xs text-iron-500 font-semibold tabular-nums">
                {fileCount}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="닫기"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-iron-400 hover:bg-iron-100 hover:text-iron-700 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4">
          <WorkspaceFolderSection />
        </div>
      </aside>
    </>
  );
}
