import type { Metadata, Viewport } from "next";
import "./globals.css"
import { ActiveDrawerProvider } from "@/features/audio/components/ActiveDrawerContext";
import { CalibrationProvider } from "@/features/audio/components/calibration/CalibrationContext";
import { WorkspaceProvider } from "@/features/audio/components/workspace/WorkspaceContext";
import { ErrorPopupProvider } from "@/shared/components/error-popup/ErrorPopupContext";
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
                {children}
              </WorkspaceProvider>
            </CalibrationProvider>
          </ActiveDrawerProvider>
        </ErrorPopupProvider>
      </body>
    </html>
  );
}
