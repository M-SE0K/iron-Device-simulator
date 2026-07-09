"use client";

// 네이비 고정 사이드바 — Header.tsx를 대체한다. 로고 + 내비 4개(대시보드/Workspace/측정 기록/Calibration).
// 실제 드로어 패널(Workspace/측정 기록/Calibration)은 DashboardClient가 #content-column 안에
// 마운트한다 — 이 컴포넌트는 트리거(내비 항목)와 활성 상태 표시만 담당한다.
import { LayoutDashboard, FolderOpen, History, SlidersHorizontal } from "lucide-react";
import { useActiveDrawer, type DrawerKey } from "@/features/audio/components/dashboard/ActiveDrawerContext";
import { useCalibration } from "@/features/audio/components/calibration/CalibrationContext";

const NAV_ITEMS: { key: DrawerKey; label: string; icon: typeof FolderOpen }[] = [
  { key: "workspace",   label: "Workspace",  icon: FolderOpen },
  { key: "records",     label: "측정 기록",   icon: History },
  { key: "calibration", label: "Calibration", icon: SlidersHorizontal },
];

interface SidebarProps {
  /** lg 미만(모바일)에서 햄버거로 연 슬라이드 오버레이 여부 — lg 이상에서는 무시(항상 고정 표시). */
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export default function Sidebar({ mobileOpen = false, onMobileClose }: SidebarProps) {
  const { active, openDrawer, closeDrawer } = useActiveDrawer();
  const { values: calibration } = useCalibration();

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
        className={`fixed lg:static inset-y-0 left-0 z-50 flex flex-col w-[248px] shrink-0 bg-brand-blue px-4 py-6 gap-1 transition-transform duration-[240ms] ease-out lg:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ paddingTop: "calc(1.5rem + env(safe-area-inset-top))" }}
      >
      {/* 로고 */}
      <div id="header-logo" className="bg-white rounded-[10px] py-2.5 px-3.5 flex items-center justify-center mb-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img id="brand-name" src="/logo_header.jpeg" alt="IRON DEVICE" className="h-[22px] w-auto object-contain" />
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

      <div className="flex-1" />

      {/* 엔진 상태 칩 — 설정된(협상되지 않은) Calibration 값 표시 */}
      <div className="flex items-center gap-2.5 px-3.5 py-3 rounded-xl bg-white/8">
        <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
        <div className="min-w-0">
          <p className="m-0 text-xs font-semibold text-white">WASM Engine</p>
          <p className="m-0.5 mt-0.5 text-[11px] text-white/50 tabular-nums truncate">
            {Number(calibration.sampleRate || 0).toLocaleString()}Hz · buf {calibration.bufferSize || "—"}
          </p>
        </div>
      </div>
      </aside>
    </>
  );
}
