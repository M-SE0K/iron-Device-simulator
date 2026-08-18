"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import ErrorPopupModal from "./ErrorPopupModal";
import type { PopupVariant } from "./popup-types";

interface QueuedMessage {
  id: number;
  message: string;
  variant: PopupVariant;
}

interface ErrorPopupContextValue {
  showError: (message: string) => void;
  showSuccess: (message: string) => void;
}

const ErrorPopupContext = createContext<ErrorPopupContextValue | null>(null);

export function ErrorPopupProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const nextIdRef = useRef(0);
  const lastKeyRef = useRef<string | null>(null);

  const enqueue = useCallback((message: string, variant: PopupVariant) => {
    if (!message) return;
    const key = `${variant}:${message}`;
    if (lastKeyRef.current === key) return;
    lastKeyRef.current = key;
    const id = nextIdRef.current++;
    setQueue((q) => [...q, { id, message, variant }]);
  }, []);

  const showError = useCallback((message: string) => enqueue(message, "error"), [enqueue]);
  const showSuccess = useCallback((message: string) => enqueue(message, "success"), [enqueue]);

  const dismissCurrent = useCallback(() => {
    setQueue((q) => q.slice(1));
    lastKeyRef.current = null;
  }, []);

  const value = useMemo(() => ({ showError, showSuccess }), [showError, showSuccess]);
  const current = queue[0] ?? null;

  return (
    <ErrorPopupContext.Provider value={value}>
      {children}
      {current && (
        <ErrorPopupModal
          message={current.message}
          variant={current.variant}
          queuedCount={queue.length - 1}
          onClose={dismissCurrent}
        />
      )}
    </ErrorPopupContext.Provider>
  );
}

export function useErrorPopup(): ErrorPopupContextValue {
  const ctx = useContext(ErrorPopupContext);
  if (!ctx) throw new Error("useErrorPopup must be used within an ErrorPopupProvider");
  return ctx;
}
