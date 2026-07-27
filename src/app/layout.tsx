import type { Metadata, Viewport } from "next";
import "./globals.css"
import { ActiveDrawerProvider } from "@/features/audio/components/dashboard/ActiveDrawerContext";
import { CalibrationProvider } from "@/features/audio/components/calibration/CalibrationContext";
import { WorkspaceProvider } from "@/features/audio/components/workspace/WorkspaceContext";
import { ErrorPopupProvider } from "@/shared/components/error-popup/ErrorPopupContext";

export const metadata: Metadata = {
  title: "Iron Device — Audio Analysis Dashboard",
  description: "Real-time audio chipset performance visualization by Iron Device",
};

// viewportFit=cover: 모바일 브라우저에서 노치·상태바 뒤까지 화면이 그려지게 해
// env(safe-area-inset-*)가 실제 값을 갖게 한다. 일반 데스크톱 브라우저에서는 무해(0px)하다.
export const viewport: Viewport = {
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>
        {/* 앱 전역 에러 팝업 — 화면 곳곳의 에러 텍스트를 화면 중앙 모달 하나로 통일 (최상위) */}
        <ErrorPopupProvider>
          {/* 우측 드로어(Workspace/측정 기록/Calibration) 배타 전환 상태 — 최상위 단일 소스 */}
          <ActiveDrawerProvider>
            {/* 캘리브레이션 파라미터를 앱 전역에서 단일 공유 (대시보드 ↔ 캘리브레이션 드로어) */}
            <CalibrationProvider>
              {/* 저장된 작업 영역(음원+분석 그래프) 목록을 앱 전역에서 단일 공유 (대시보드 ↔ 워크스페이스 드로어) */}
              <WorkspaceProvider>
                {children}
              </WorkspaceProvider>
            </CalibrationProvider>
          </ActiveDrawerProvider>
        </ErrorPopupProvider>
      </body>
    </html>
  );
}
