"use client";

import { createContext, useContext, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { loadCalibrationCache, saveCalibrationCache } from "@/features/audio/lib/cache/calibration";
import type { CalibrationValues } from "@/features/audio/types";
import { CALIBRATION_EMPTY } from "./calibration-options";

export {
  SAMPLE_RATE_OPTIONS,
  BUFFER_SIZE_OPTIONS,
  CHANNEL_OPTIONS,
  CALIBRATION_EMPTY,
} from "./calibration-options";

interface CalibrationCtx {
  values: CalibrationValues;
  setValues: Dispatch<SetStateAction<CalibrationValues>>;
}

const Ctx = createContext<CalibrationCtx | null>(null);

export function CalibrationProvider({ children }: { children: ReactNode }) {
  const [values, setValues] = useState<CalibrationValues>(CALIBRATION_EMPTY);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const cached = loadCalibrationCache();
    if (cached) setValues((v) => ({ ...v, ...cached }));
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveCalibrationCache(values);
  }, [hydrated, values]);

  const ctx = useMemo(() => ({ values, setValues }), [values]);
  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

export function useCalibration(): CalibrationCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCalibration must be used within CalibrationProvider");
  return ctx;
}
