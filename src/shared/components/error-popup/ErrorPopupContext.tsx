"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import ErrorPopupModal from "./ErrorPopupModal";

export type PopupVariant = "error" | "success";

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

/**
 * 앱 전역 피드백 팝업 — 화면 곳곳에 흩어져 있던 에러 텍스트(재생/캡처, 캘리브레이션 적용,
 * 워크스페이스 로컬 폴더, 채널 뷰어 등)와 "적용 완료" 같은 성공 피드백을 화면 중앙 모달
 * 하나로 통일한다. 여러 곳에서 거의 동시에 메시지가 발생해도(예: 캡처 세션이 끊기면서
 * 상위 상태와 하위 훅이 같이 에러를 세팅하는 경우) 놓치지 않도록 큐로 쌓고, 닫기 버튼을
 * 눌러야만 다음 메시지로 넘어간다.
 */
export function ErrorPopupProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const nextIdRef = useRef(0);
  const lastKeyRef = useRef<string | null>(null);

  const enqueue = useCallback((message: string, variant: PopupVariant) => {
    if (!message) return;
    // 같은 메시지가 연속으로 재세팅되는 경우(리렌더 등)는 중복 팝업으로 쌓지 않는다.
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
