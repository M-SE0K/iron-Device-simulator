import type { Metadata } from "next";
import "./globals.css";
import { CalibrationProvider } from "@/features/audio/lib/calibration-context";
import AuthSessionWatcher from "@/shared/components/AuthSessionWatcher";

export const metadata: Metadata = {
  title: "Iron Device — Audio Analysis Dashboard",
  description: "Real-time audio chipset performance visualization by Iron Device",
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
          <AuthSessionWatcher />
          {children}
        </CalibrationProvider>
      </body>
    </html>
  );
}
