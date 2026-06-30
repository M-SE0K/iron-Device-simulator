"use client";

// 좌측 슬라이딩 드로어 — 내용물로 워크스페이스 트리(WorkspaceTree)를 담는다.
// 트리거(햄버거)·오버레이·슬라이드 패널 동작은 유지하고, 본문만 내비 링크 → WorkspaceTree 로 교체.
// 성능: 드로어를 처음 연 시점에 1회 마운트(지연) 후 계속 유지 → 매 페이지 로드마다 트리 fetch 하지 않음.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Menu, X } from "lucide-react";
import WorkspaceTree from "@/features/workspace/components/WorkspaceTree";

export default function SideNav() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false); // 첫 오픈 후 WorkspaceTree 유지
  const router = useRouter();

  // Esc 로 닫기 + 열렸을 때 배경 스크롤 잠금
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  const openDrawer = () => {
    setMounted(true);
    setOpen(true);
  };

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  return (
    <>
      {/* 트리거 (좌측 탭) */}
      <button
        type="button"
        onClick={openDrawer}
        aria-label="워크스페이스 열기"
        aria-expanded={open}
        className="flex items-center justify-center w-9 h-9 rounded-lg text-iron-500 hover:bg-iron-100 hover:text-iron-900 transition"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* 배경 오버레이 */}
      <div
        onClick={() => setOpen(false)}
        aria-hidden
        className={`fixed inset-0 z-40 bg-iron-900/30 backdrop-blur-[1px] transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />

      {/* 슬라이딩 패널 — 본문은 워크스페이스 트리(선택 전용) */}
      <aside
        className={`fixed top-0 left-0 z-50 h-full w-80 max-w-[88vw] bg-iron-50 border-r border-iron-100 shadow-xl flex flex-col transition-transform duration-300 ease-out ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        role="dialog"
        aria-label="워크스페이스"
        aria-hidden={!open}
      >
        <div className="h-14 px-4 shrink-0 flex items-center justify-between border-b border-iron-100 bg-white">
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="닫기"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-iron-400 hover:bg-iron-100 hover:text-iron-700 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 본문: 워크스페이스 트리 (선택 전용 — 프로젝트 클릭 시 /workspace 로 이동 + 닫기) */}
        <div className="flex-1 min-h-0 p-3 overflow-hidden">
          {mounted && <WorkspaceTree variant="nav" onSelect={() => setOpen(false)} />}
        </div>

        <div className="p-2 border-t border-iron-100 shrink-0 bg-white">
          <button
            type="button"
            onClick={logout}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-iron-500 hover:bg-iron-100 transition"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            로그아웃
          </button>
        </div>
      </aside>
    </>
  );
}
