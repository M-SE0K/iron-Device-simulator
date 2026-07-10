"use client";

import { useEffect, useRef } from "react";

/**
 * Escape 키를 누르면 `handler`를 호출한다 — 드로어/오버레이의 "ESC로 닫기" 공용 훅.
 * `enabled`가 false면 리스너를 등록하지 않는다(닫힌 드로어에서 전역 키를 잡지 않기 위함).
 * `handler`는 ref로 참조하므로 매 렌더 새 함수를 넘겨도 리스너를 다시 붙이지 않고
 * 항상 최신 핸들러를 호출한다.
 */
export function useEscapeKey(handler: () => void, enabled: boolean = true): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handlerRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
