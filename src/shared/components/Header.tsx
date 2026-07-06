"use client";

import CalibrationDrawer from "@/features/audio/components/calibration/CalibrationDrawer";
import WorkspaceDrawer from "@/features/audio/components/workspace/WorkspaceDrawer";

export default function Header() {
  return (
    <header
      id="app-header"
      className="bg-white border-b border-iron-100 px-4 sm:px-6 py-0 flex items-center gap-3 h-14 shrink-0"
      style={{ paddingTop: "env(safe-area-inset-top)", height: "calc(3.5rem + env(safe-area-inset-top))" }}
    >
      {/* 좌측(로고 옆): 저장된 세션(음원+분석 그래프) 작업 영역 드로어 */}
      <WorkspaceDrawer />
      {/* Logo area */}
      <div id="header-logo" className="flex items-center gap-3 min-w-0">
        <div className="header-brand truncate">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img id="brand-name" src="/logo_header.jpeg" alt="IRON DEVICE" className="h-7 w-auto object-contain" />
        </div>
      </div>
      {/* 우측: 캘리브레이션 파라미터(단일 소스) 드로어 */}
      <div className="ml-auto">
        <CalibrationDrawer />
      </div>
    </header>
  );
}
