"use client";

import { X } from "lucide-react";
import type { ReactNode } from "react";

interface SideDrawerProps {
  open: boolean;
  /** 백드롭 클릭 + 기본 헤더의 닫기 버튼이 호출 */
  onClose: () => void;
  ariaLabel: string;
  /**
   * content-column 기준(absolute, z-40/50) vs 전체화면 오버레이 위(fixed, z-[61]/[62]).
   * 대부분의 사이드바 드로어는 "content", 오버레이 안에서 여는 드로어만 "overlay".
   */
  layer?: "content" | "overlay";
  /** 슬라이드 방향 — 기본은 우측(right). 좌측 Sidebar 옆에서 여는 드로어는 "left". */
  side?: "left" | "right";
  /** 패널 폭 클래스 — 기본은 320px(다른 사이드 드로어와 동일). 차트처럼 넓은 본문은 오버라이드. */
  widthClassName?: string;
  /** 상단 safe-area 여백(전체화면 오버레이 위에 뜨는 드로어) */
  safeAreaTop?: boolean;
  /** 기본 헤더(제목 + 카운트 pill + 닫기) 대신 통째로 쓸 커스텀 헤더 */
  header?: ReactNode;
  /** 기본 헤더 제목 — header 미지정 시 사용 */
  title?: string;
  /** 제목 옆 카운트 pill — 0보다 클 때만 표시(header 미지정 시) */
  count?: number;
  /** 스크롤 본문 래퍼 클래스(기본 "p-4"; Calibration은 "p-4 space-y-5") */
  bodyClassName?: string;
  /** 본문 아래 고정 푸터(Calibration의 적용/초기화 바 등) */
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * 사이드 슬라이드 드로어 공용 셸 — 백드롭(300ms 페이드) + 좌/우 패널(240ms 슬라이드) + 기본
 * 헤더/본문/푸터. WorkspaceDrawer / RecordsDrawer / CalibrationDrawer / ChannelSelectDrawer /
 * ChartDetailOverlay가 복붙하던 동일 마크업을 통합한다. 기본은 우측(side="right") — 좌측
 * Sidebar 옆에서 여는 ChartDetailOverlay만 side="left"를 쓴다. ESC 닫기는 셸이 강제하지
 * 않는다 — 각 드로어가 스스로 useEscapeKey로 관리한다(오버레이 위 드로어인
 * ChannelSelectDrawer는 부모의 open 상태를 그대로 물려받는다).
 */
export default function SideDrawer({
  open,
  onClose,
  ariaLabel,
  layer = "content",
  side = "right",
  widthClassName = "w-[320px] max-w-[82vw]",
  safeAreaTop = false,
  header,
  title,
  count,
  bodyClassName = "p-4",
  footer,
  children,
}: SideDrawerProps) {
  const backdropPos = layer === "overlay" ? "fixed z-[61]" : "absolute z-40";
  const panelPos = layer === "overlay" ? "fixed z-[62]" : "absolute z-50";
  const sidePos = side === "left" ? "left-0" : "right-0";
  const sideBorder = side === "left" ? "border-r" : "border-l";
  const sideShadow = side === "left"
    ? "shadow-[12px_0_40px_rgba(15,23,42,0.16)]"
    : "shadow-[-12px_0_40px_rgba(15,23,42,0.16)]";
  const closedTranslate = side === "left" ? "-translate-x-full" : "translate-x-full";

  return (
    <>
      {/* 배경 오버레이 */}
      <div
        onClick={onClose}
        aria-hidden
        className={`${backdropPos} inset-0 bg-iron-900/30 backdrop-blur-[1px] transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />

      {/* 슬라이딩 패널 */}
      <aside
        className={`${panelPos} top-0 ${sidePos} h-full ${widthClassName} bg-white ${sideBorder} border-iron-100 ${sideShadow} flex flex-col transition-transform duration-[240ms] ease-out ${
          open ? "translate-x-0" : closedTranslate
        }`}
        style={safeAreaTop ? { paddingTop: "env(safe-area-inset-top)" } : undefined}
        role="dialog"
        aria-label={ariaLabel}
        aria-hidden={!open}
      >
        {header ?? (
          <div className="px-5 pt-5 pb-4 shrink-0 flex items-center justify-between border-b border-iron-100">
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="m-0 text-lg font-bold text-iron-900">{title}</h2>
              {count !== undefined && count > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-iron-100 text-xs text-iron-500 font-semibold tabular-nums">
                  {count}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex items-center justify-center w-8 h-8 rounded-lg text-iron-400 hover:bg-iron-100 hover:text-iron-700 transition shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className={`flex-1 min-h-0 overflow-auto ${bodyClassName}`}>{children}</div>

        {footer}
      </aside>
    </>
  );
}
