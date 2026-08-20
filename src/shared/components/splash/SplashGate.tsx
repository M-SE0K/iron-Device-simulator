"use client";

import { useEffect, useState } from "react";
import LoadingSplash from "./LoadingSplash";

/**
 * 앱 콘텐츠 위에 로딩 화면을 덮어두는 게이트.
 *
 * children 은 처음부터 마운트된 채로 스플래시 뒤에서 초기화된다(대시보드/브리지 준비를
 * 지연시키지 않는다). ENTER 를 누르면 스플래시만 사라진다.
 */
export default function SplashGate({ children }: { children: React.ReactNode }) {
  const [showSplash, setShowSplash] = useState(true);

  // 스플래시가 떠 있는 동안 뒤쪽 대시보드가 스크롤되지 않게 막는다.
  useEffect(() => {
    if (!showSplash) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [showSplash]);

  return (
    <>
      {children}
      {showSplash && <LoadingSplash onFinish={() => setShowSplash(false)} />}
    </>
  );
}
