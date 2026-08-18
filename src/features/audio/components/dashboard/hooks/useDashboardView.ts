"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readSessionJson, writeSessionJson } from "@/features/audio/lib/cache/session-json";

export const VIEW_PROTECTED = "protected";
export const VIEW_EXCURSION = "excursion";
export const VIEW_TEMPERATURE = "temperature";

export const viewChannelId = (ch: number) => `ch:${ch}`;
export const parseViewChannelId = (id: string): number | null => {
  if (!id.startsWith("ch:")) return null;
  const ch = Number(id.slice(3));
  return Number.isInteger(ch) && ch >= 0 ? ch : null;
};

export const PROTECTED_INPUT_L = "protected:input-l";
export const PROTECTED_INPUT_R = "protected:input-r";
export const PROTECTED_PROTECTED_L = "protected:protected-l";
export const PROTECTED_PROTECTED_R = "protected:protected-r";
export const PROTECTED_SERIES_IDS = [
  PROTECTED_INPUT_L,
  PROTECTED_INPUT_R,
  PROTECTED_PROTECTED_L,
  PROTECTED_PROTECTED_R,
] as const;

const DEFAULT_VIEW_SELECTION = [VIEW_PROTECTED, VIEW_EXCURSION, VIEW_TEMPERATURE, ...PROTECTED_SERIES_IDS];

const STORAGE_KEY = "iron-device-dashboard-view-v1";

export function useDashboardView() {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(DEFAULT_VIEW_SELECTION));
  const hydratedRef = useRef(false);

  useEffect(() => {
    const ids = readSessionJson<unknown>(STORAGE_KEY);
    if (Array.isArray(ids)) {
      setSelected(new Set(ids.filter((v): v is string => typeof v === "string")));
    }
    hydratedRef.current = true;
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    writeSessionJson(STORAGE_KEY, Array.from(selected));
  }, [selected]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return { selected, toggle };
}
