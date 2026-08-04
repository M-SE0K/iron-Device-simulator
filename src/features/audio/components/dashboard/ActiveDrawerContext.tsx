"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type DrawerKey = "view" | "workspace" | "records" | "calibration";

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

export function useDrawerState(key: DrawerKey): { open: boolean; setOpen: (open: boolean) => void } {
  const { active, openDrawer, closeDrawer } = useActiveDrawer();
  const setOpen = useCallback(
    (open: boolean) => (open ? openDrawer(key) : closeDrawer()),
    [key, openDrawer, closeDrawer],
  );
  return { open: active === key, setOpen };
}
