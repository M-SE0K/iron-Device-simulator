"use client";

import type { CSSProperties, ReactNode } from "react";

interface FullscreenOverlayProps {
  /** useOverlayTransition의 show — 진입/이탈 페이드+슬라이드 토글 */
  show: boolean;
  ariaLabel: string;
  children: ReactNode;
}

/**
 * 전체 화면 오버레이(ChartDetailOverlay / ChannelViewerOverlay)의 공용 루트 셸.
 * 진입/이탈 전환·ESC 닫기 로직은 useOverlayTransition이 담당하고, 여기서는 그
 * `show`를 받아 루트 컨테이너의 트랜지션 클래스와 safe-area 여백만 그린다.
 * 헤더/본문은 오버레이마다 달라 children으로 받는다.
 */
export default function FullscreenOverlay({ show, ariaLabel, children }: FullscreenOverlayProps) {
  const style: CSSProperties = { paddingTop: "env(safe-area-inset-top)" };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      className={`fixed inset-0 z-[60] flex flex-col bg-iron-50 transition-all duration-300 ease-out ${
        show ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
      }`}
      style={style}
    >
      {children}
    </div>
  );
}
