"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEscapeKey } from "./useEscapeKey";

/**
 * 전체 화면 오버레이(ChannelViewerOverlay)의 진입/이탈 전환 공용 훅.
 * 마운트 직후 rAF로 `show=true`(진입 애니메이션), `close()`는 `show=false`로 전환한 뒤
 * `durationMs`(기본 250ms) 후 `onClose`를 호출해 언마운트한다. Escape로도 닫힌다.
 * 반환한 `show`로 트랜지션 클래스를, `close`로 닫기 버튼을 연결한다.
 */
export function useOverlayTransition(
  onClose: () => void,
  durationMs: number = 250,
): { show: boolean; close: () => void } {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const close = useCallback(() => {
    setShow(false);
    window.setTimeout(() => onCloseRef.current(), durationMs);
  }, [durationMs]);

  useEscapeKey(close);

  return { show, close };
}
