"use client";

import SideNav from "@/shared/components/SideNav";
import CalibrationDrawer from "@/features/workspace/components/CalibrationDrawer";

export default function Header() {
  return (
    <header id="app-header" className="bg-white border-b border-iron-100 px-4 sm:px-6 py-0 flex items-center gap-3 h-14 shrink-0">
      {/* 좌측: 워크스페이스 트리 선택 드로어 */}
      <SideNav />
      {/* Logo area */}
      <div id="header-logo" className="flex items-center gap-3 min-w-0">
        <div className="header-brand truncate">
          <span id="brand-name" className="text-sm font-bold text-iron-900 tracking-tight">IRON DEVICE</span>
        </div>
      </div>
      {/* 우측: 캘리브레이션 파라미터(단일 소스) 드로어 */}
      <div className="ml-auto">
        <CalibrationDrawer />
      </div>
    </header>
  );
}
