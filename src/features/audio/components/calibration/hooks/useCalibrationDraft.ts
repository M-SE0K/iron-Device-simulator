"use client";

// 캘리브레이션 드로어의 로컬 draft 상태 — "적용" 전까지는 Context(committed values)에
// 반영되지 않는다. 드로어가 열릴 때마다 draft를 최신 committed 값으로 동기화한다
// (deviceStatus/adjustedNote 리셋 + 장치 새로고침은 여러 훅을 가로지르는 별도 오케스트레이션
// effect로, CalibrationDrawer 본체에 그대로 둔다 — 같은 [open] 의존성 effect가 여러 개
// 있어도 React는 선언 순서대로 전부 실행하므로 동작은 하나였을 때와 동일하다).
import { useCallback, useEffect, useState } from "react";
import type { CalibrationValues } from "../CalibrationContext";

export function useCalibrationDraft(open: boolean, values: CalibrationValues) {
  const [draft, setDraft] = useState<CalibrationValues>(values);

  useEffect(() => {
    if (!open) return;
    setDraft(values);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = useCallback((patch: Partial<CalibrationValues>) => {
    setDraft((v) => ({ ...v, ...patch }));
  }, []);

  return { draft, setDraft, set };
}
