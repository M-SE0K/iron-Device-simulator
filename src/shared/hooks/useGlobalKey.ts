"use client";

import { useEffect, useRef } from "react";

function useWindowKeydown(
  matches: (e: KeyboardEvent) => boolean,
  handler: () => void,
  enabled: boolean,
  preventDefault: boolean,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!matchesRef.current(e)) return;
      if (preventDefault) e.preventDefault();
      handlerRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, preventDefault]);
}

export function useCtrlBToggle(handler: () => void): void {
  useWindowKeydown(
    (e) => (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b",
    handler,
    true,
    true,
  );
}

export function useEscapeKey(handler: () => void, enabled: boolean = true): void {
  useWindowKeydown((e) => e.key === "Escape", handler, enabled, false);
}
