"use client";

// 대시보드 View(표시 차트 구성) 상태 — 좌측 Sidebar의 View 탭이 토글하는 선택 집합을
// 소유한다. 기본값은 예전 고정 배치와 동일(Protection 전체 폭 1행 + Excursion/Temperature
// 2행). 선택은 sessionStorage에 남겨 F5 뒤에도 차트 캐시(lib/cache/frame.ts)와 같은
// 수명으로 배치가 유지되게 한다.
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

const DEFAULT_VIEW_SELECTION = [VIEW_PROTECTED, VIEW_EXCURSION, VIEW_TEMPERATURE];

const STORAGE_KEY = "iron-device-dashboard-view-v1";

export function useDashboardView() {
  // 첫 렌더는 SSR(정적 export의 프리렌더 HTML)과 동일하게 기본값으로 시작하고, 저장된
  // 선택은 마운트 후에 복원한다 — 초기값에서 바로 storage를 읽으면 hydration mismatch가 난다.
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
