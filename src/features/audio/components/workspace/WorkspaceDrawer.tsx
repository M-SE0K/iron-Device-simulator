"use client";

// 좌측 슬라이딩 드로어 — 저장된 세션(음원 + 분석 그래프) 작업 영역. VSCode 워크스페이스 참고.
// 대시보드 "저장" 버튼(DashboardClient.handleSaveToWorkspace)이 세션을 추가하면 이 드로어가
// 자동으로 열린다(workspace-context.saveCurrent). 목록 항목(WorkspaceItemRow)은 더블클릭 또는
// 연필 아이콘으로 이름을 바로 수정할 수 있고, JSON/CSV/오디오 원본을 각각 다운로드할 수 있다.
// 폴더 연결 UI는 WorkspaceFolderSection이 맡는다.
import { useEffect } from "react";
import { Menu, Save, X } from "lucide-react";
import { useWorkspace } from "./WorkspaceContext";
import WorkspaceFolderSection from "./WorkspaceFolderSection";
import WorkspaceItemRow from "./WorkspaceItemRow";

export default function WorkspaceDrawer() {
  const { items, open, setOpen } = useWorkspace();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  return (
    <>
      {/* 트리거 (좌측) */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="작업 영역 열기"
        aria-expanded={open}
        className="flex items-center gap-1.5 px-3 h-9 rounded-lg hover:bg-iron-100 hover:text-iron-900 transition"
      >
        <Menu className="w-4 h-4" />
        {items.length > 0 && (
          <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-iron-100 text-[10px] text-iron-500 font-mono">
            {items.length}
          </span>
        )}
      </button>

      {/* 배경 오버레이 */}
      <div
        onClick={() => setOpen(false)}
        aria-hidden
        className={`fixed inset-0 z-40 bg-iron-900/30 backdrop-blur-[1px] transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />

      {/* 좌측 슬라이딩 패널 */}
      <aside
        className={`fixed top-0 left-0 z-50 h-full w-80 max-w-[92vw] bg-white border-r border-iron-100 shadow-xl flex flex-col transition-transform duration-300 ease-out ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        role="dialog"
        aria-label="작업 영역"
        aria-hidden={!open}
      >
        <div className="h-14 px-4 shrink-0 flex items-center justify-between border-b border-iron-100">
          <div className="flex items-center gap-2 min-w-0">
            <Menu className="w-4 h-4 text-brand-blue shrink-0" />
            <span className="text-sm font-semibold text-iron-900">Workspace</span>
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

        <div className="flex-1 min-h-0 overflow-auto p-2">
          <WorkspaceFolderSection />
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6">
              <Save className="w-6 h-6 text-iron-200" />
              <p className="text-xs text-iron-400 leading-relaxed">
                대시보드의 저장 버튼을 누르면
                <br />
                음원과 분석 결과가 여기에 보존됩니다.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {items.map((item) => (
                <WorkspaceItemRow key={item.id} item={item} />
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
