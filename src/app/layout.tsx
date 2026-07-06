import type { Metadata, Viewport } from "next";
import "./globals.css"
import { CalibrationProvider } from "@/features/audio/components/calibration/Calibration-context";
import { WorkspaceProvider } from "@/features/audio/components/workspace/Workspace-context";

export const metadata: Metadata = {
  title: "Iron Device — Audio Analysis Dashboard",
  description: "Real-time audio chipset performance visualization by Iron Device",
};

// viewportFit=cover: iOS/Android 노치·상태바 뒤까지 웹뷰가 그려지게 해
// env(safe-area-inset-*)가 실제 값을 갖게 한다(Capacitor 모바일 패키징용).
// 일반 브라우저에서는 무해(0px)하다.
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
        {/* 캘리브레이션 파라미터를 앱 전역에서 단일 공유 (대시보드 ↔ 캘리브레이션 드로어) */}
        <CalibrationProvider>
          {/* 저장된 작업 영역(음원+분석 그래프) 목록을 앱 전역에서 단일 공유 (대시보드 ↔ 워크스페이스 드로어) */}
          <WorkspaceProvider>
            {children}
          </WorkspaceProvider>
        </CalibrationProvider>
      </body>
    </html>
  );
}
