"use client";

// 우측 드로어 배타 전환 (Sidebar 내비 4개 중 하나만 슬롯을 차지) — 앱 전역 단일 소스.
// Workspace/Calibration/측정 기록 세 드로어가 이 컨텍스트로 open 여부를 파생시킨다
// (WorkspaceContext.open, CalibrationDrawer 로컬 open 이 각각 이 값을 감싸는 얇은 wrapper가 됨).
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type DrawerKey = "workspace" | "records" | "calibration";

interface ActiveDrawerCtx {
  active: DrawerKey | null;
  openDrawer: (key: DrawerKey) => void;
  closeDrawer: () => void;
}

const Ctx = createContext<ActiveDrawerCtx | null>(null);

export function ActiveDrawerProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<DrawerKey | null>(null);

  const openDrawer = useCallback((key: DrawerKey) => setActive(key), []);
  const closeDrawer = useCallback(() => setActive(null), []);

  const ctx = useMemo<ActiveDrawerCtx>(
    () => ({ active, openDrawer, closeDrawer }),
    [active, openDrawer, closeDrawer],
  );

  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

export function useActiveDrawer(): ActiveDrawerCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useActiveDrawer must be used within ActiveDrawerProvider");
  return ctx;
}
