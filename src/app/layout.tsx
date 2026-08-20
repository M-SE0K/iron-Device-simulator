import type { Metadata, Viewport } from "next";
import "./globals.css"
import { ActiveDrawerProvider } from "@/features/audio/components/ActiveDrawerContext";
import { CalibrationProvider } from "@/features/audio/components/calibration/CalibrationContext";
import { WorkspaceProvider } from "@/features/audio/components/workspace/WorkspaceContext";
import { ErrorPopupProvider } from "@/shared/components/error-popup/ErrorPopupContext";
// 시작 로딩 화면 임시 비활성화 — 되살리려면 아래 두 곳의 주석을 함께 해제할 것
// import SplashGate from "@/shared/components/splash/SplashGate";
import TauriBridgeInit from "./TauriBridgeInit";
import IronPerfInit from "./IronPerfInit";

export const metadata: Metadata = {
  title: "Iron Device — Audio Analysis Dashboard",
  description: "Real-time audio chipset performance visualization by Iron Device",
};

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
        <TauriBridgeInit />
        <IronPerfInit />
        <ErrorPopupProvider>
          <ActiveDrawerProvider>
            <CalibrationProvider>
              <WorkspaceProvider>
                {/* <SplashGate>{children}</SplashGate> */}
                {children}
              </WorkspaceProvider>
            </CalibrationProvider>
          </ActiveDrawerProvider>
        </ErrorPopupProvider>
      </body>
    </html>
  );
}
