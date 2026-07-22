"use client";

import { useCallback, useEffect, useState } from "react";
import type { CalibrationValues } from "@/features/audio/types";

export function useCalibrationDraft(open: boolean, values: CalibrationValues) {
  const [draft, setDraft] = useState<CalibrationValues>(values);

  useEffect(() => {
    if (!open) return;
    setDraft(values);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = useCallback((patch: Partial<CalibrationValues>) => {
    setDraft((v) => ({ ...v, ...patch }));
  }, []);

  return { draft, setDraft, set };
}
