"use client";

import { memo } from "react";
import { LayoutGrid, FolderOpen, History, SlidersHorizontal } from "lucide-react";
import type { DrawerKey } from "../ActiveDrawerContext";

const NAV_ITEMS: { key: DrawerKey; icon: typeof FolderOpen; label: string }[] = [
  { key: "view",        icon: LayoutGrid,          label: "View" },
  { key: "workspace",   icon: FolderOpen,          label: "Workspace" },
  { key: "records",     icon: History,             label: "Records" },
  { key: "calibration", icon: SlidersHorizontal,   label: "Calibration" },
];

interface SidebarProps {
  activeDrawer: DrawerKey | null;
  onOpenDrawer: (key: DrawerKey) => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  collapsed?: boolean;
}

function Sidebar({
  activeDrawer,
  onOpenDrawer,
  mobileOpen = false,
  onMobileClose,
  collapsed = false,
}: SidebarProps) {
  const handleNav = (fn: () => void) => {
    fn();
    onMobileClose?.();
  };

  return (
    <>
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
      <div id="header-logo" className="px-1 mb-6">
        <span id="brand-name" className="text-white text-[15px] font-extrabold tracking-tight">
          IRON DEVICE
        </span>
      </div>

      {NAV_ITEMS.map(({ key, icon: Icon, label }) => {
        const isActive = activeDrawer === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => handleNav(() => onOpenDrawer(key))}
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

export default memo(Sidebar);
