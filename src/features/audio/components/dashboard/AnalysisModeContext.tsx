"use client";

// 입력 소스(파일/마이크) 토글을 대시보드 밖(Calibration 드로어)에서 조작하기 위한 얇은 컨텍스트.
// 상태와 전환 핸들러(버퍼/캐시 정리 등 부작용)는 여전히 DashboardClient가 소유하고, 이 컨텍스트로
// 값만 하위 트리(Header→CalibrationDrawer)에 노출한다. 파일/마이크 모두 분석은 항상 캡처
// 파이프라인(useCaptureSession)으로 동일하게 동작하므로 별도의 "분석 모드" 개념은 없다 —
// 파일 모드는 재생(출력)이 추가로 붙을 뿐이다.
// Provider는 DashboardClient가 자신의 반환 JSX를 감싸며 제공하므로, 대시보드 밖에서는 null 이다.
import { createContext, useContext } from "react";

type InputMode = "file" | "mic";

export interface AnalysisModeContextValue {
  inputMode: InputMode;
  setInputMode: (m: InputMode) => void;
}

const AnalysisModeContext = createContext<AnalysisModeContextValue | null>(null);

export const AnalysisModeProvider = AnalysisModeContext.Provider;

/** 대시보드 밖(Provider 부재)에서는 null 을 반환하므로 호출부에서 널 체크한다. */
export function useAnalysisMode(): AnalysisModeContextValue | null {
  return useContext(AnalysisModeContext);
}
