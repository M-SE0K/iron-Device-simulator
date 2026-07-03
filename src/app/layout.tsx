import type { Metadata, Viewport } from "next";
import "./globals.css";
import { CalibrationProvider } from "@/features/audio/lib/calibration-context";

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
          {children}
        </CalibrationProvider>
      </body>
    </html>
  );
}
