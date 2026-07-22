"use client";

import { useEffect, useRef } from "react";

/**
 * Ctrl/Cmd+B를 누르면 `handler`를 호출한다 — 사이드바/드로어 토글 공용 단축키 훅.
 * `handler`는 ref로 참조하므로 매 렌더 새 함수를 넘겨도 리스너를 다시 붙이지 않는다.
 */
export function useCtrlBToggle(handler: () => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        handlerRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
