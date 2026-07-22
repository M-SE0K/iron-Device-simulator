"use client";

import { memo } from "react";
import { LayoutDashboard, FolderOpen, History, SlidersHorizontal } from "lucide-react";
import { useActiveDrawer, type DrawerKey } from "@/features/audio/components/dashboard/ActiveDrawerContext";

const NAV_ITEMS: { key: DrawerKey; label: string; icon: typeof FolderOpen }[] = [
  { key: "workspace",   label: "Workspace",  icon: FolderOpen },
  { key: "records",     label: "측정 기록",   icon: History },
  { key: "calibration", label: "Calibration", icon: SlidersHorizontal },
];

interface SidebarProps {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  collapsed?: boolean;
}

function Sidebar({ mobileOpen = false, onMobileClose, collapsed = false }: SidebarProps) {
  const { active, openDrawer, closeDrawer } = useActiveDrawer();

  const handleNav = (fn: () => void) => {
    fn();
    onMobileClose?.();
  };

  return (
    <>
      {/* 모바일 전용 백드롭 — lg 이상에서는 렌더되지 않음(사이드바가 항상 고정 표시) */}
      <div
        onClick={onMobileClose}
        aria-hidden
        className={`lg:hidden fixed inset-0 z-40 bg-iron-900/30 backdrop-blur-[1px] transition-opacity duration-300 ${
          mobileOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />
      <aside
        id="app-sidebar"
        aria-hidden={collapsed}
        className={`fixed lg:static inset-y-0 left-0 z-50 flex flex-col shrink-0 overflow-hidden bg-brand-blue gap-1 transition-all duration-[240ms] ease-out lg:duration-300 lg:ease-in-out lg:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        } ${
          collapsed
            ? "w-[188px] max-w-[78vw] px-4 py-6 lg:w-0 lg:max-w-0 lg:px-0 lg:opacity-0 lg:pointer-events-none"
            : "w-[188px] max-w-[78vw] px-4 py-6 lg:opacity-100"
        }`}
        style={{ paddingTop: "calc(1.5rem + env(safe-area-inset-top))" }}
      >
      {/* 로고 — 이미지 대신 텍스트 워드마크 */}
      <div id="header-logo" className="px-1 mb-6">
        <span id="brand-name" className="text-white text-[15px] font-extrabold tracking-tight">
          IRON DEVICE
        </span>
      </div>

      {/* 대시보드(드로어 전부 닫기) */}
      <button
        type="button"
        onClick={() => handleNav(closeDrawer)}
        aria-current={active === null}
        className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-[10px] text-sm transition-colors duration-200 ${
          active === null ? "bg-white/14 text-white font-semibold" : "text-white/65 font-medium hover:bg-white/8 hover:text-white/90"
        }`}
      >
        <LayoutDashboard className="w-4 h-4 shrink-0" />
        대시보드
      </button>

      {NAV_ITEMS.map(({ key, label, icon: Icon }) => {
        const isActive = active === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => handleNav(() => openDrawer(key))}
            aria-current={isActive}
            className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-[10px] text-sm transition-colors duration-200 ${
              isActive ? "bg-white/14 text-white font-semibold" : "text-white/65 font-medium hover:bg-white/8 hover:text-white/90"
            }`}
          >
            <Icon className="w-4 h-4 shrink-0" />
            {label}
          </button>
        );
      })}
      </aside>
    </>
  );
}

// 대시보드가 실시간 프레임 갱신으로 주기적으로 리렌더돼도 사이드바 props는 토글 시에만
// 바뀐다 — memo로 캡처 중 불필요한 리렌더를 차단한다(onMobileClose는 부모에서 useCallback).
export default memo(Sidebar);
