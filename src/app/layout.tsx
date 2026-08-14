import type { Metadata, Viewport } from "next";
import "./globals.css"
import { ActiveDrawerProvider } from "@/features/audio/components/dashboard/ActiveDrawerContext";
import { CalibrationProvider } from "@/features/audio/components/calibration/CalibrationContext";
import { WorkspaceProvider } from "@/features/audio/components/workspace/WorkspaceContext";
import { ErrorPopupProvider } from "@/shared/components/error-popup/ErrorPopupContext";
import TauriBridgeInit from "./TauriBridgeInit";
import IronPerfInit from "./IronPerfInit";

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
    <html lang="en">
      <body>
        {/* Tauri shim 설치 부트스트랩 — 정적 import 시 모듈 스코프에서 installTauriBridge()가
            실행되며, 이 컴포넌트는 아무것도 렌더링하지 않는다. */}
        <TauriBridgeInit />
        {/* 파이프라인 4개 노드 성능 계측(window.__ironPerf) — NEXT_PUBLIC_IRON_PERF=1 로 빌드한
            경우에만 실제로 설치되고, 아니면 전체가 dead-code로 제거된다. TauriBridgeInit 뒤에
            와야 한다: 네이티브 perf 이벤트 구독이 Tauri shim 설치를 전제한다. */}
        <IronPerfInit />
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
