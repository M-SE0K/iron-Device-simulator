"use client";

// 캘리브레이션 파라미터 단일 소스 (앱 전역 Context).
// 대시보드(InputParameters 대체)와 CalibrationDrawer 가 같은 값을 공유한다 — "캘리브레이션 단일 적용".
// 엔진에 실제로 전달되는 값은 speakerModel·ampOutputPower 이며, 나머지(주변온도/프로파일 보정)는
// 향후 ff_prot_set_param 연동을 위한 선행 필드다(현재 모델별 SPEAKER_PROFILES 로 후처리).
import { createContext, useContext, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { SPEAKER_PROFILES } from "@/features/audio/lib/engine-core";

export const SPEAKER_MODELS = Object.keys(SPEAKER_PROFILES); // ["Z3 SPK", ...]
export const DEFAULT_AMBIENT = 25;

export interface CalibrationValues {
  speakerModel: string; // "" = 미선택
  ampOutputPower: string; // W
  ambientTemp: string; // °C
  tempBase: string; // °C (프로파일)
  excAmp: string; // mm (프로파일)
  tempMult: string; // 승수
  excMult: string; // 승수
}

export const CALIBRATION_EMPTY: CalibrationValues = {
  speakerModel: "",
  ampOutputPower: "20",
  ambientTemp: String(DEFAULT_AMBIENT),
  tempBase: "",
  excAmp: "",
  tempMult: "",
  excMult: "",
};

/** 선택 모델의 프로파일 값으로 보정 4필드를 채운 사본 반환 */
export function withProfile(values: CalibrationValues, model: string): CalibrationValues {
  const p = SPEAKER_PROFILES[model];
  if (!p) return { ...values, speakerModel: model, tempBase: "", excAmp: "", tempMult: "", excMult: "" };
  return {
    ...values,
    speakerModel: model,
    tempBase: String(p.tempBase),
    excAmp: String(p.excAmp),
    tempMult: String(p.tempMult),
    excMult: String(p.excMult),
  };
}

interface CalibrationCtx {
  values: CalibrationValues;
  setValues: Dispatch<SetStateAction<CalibrationValues>>;
}

const Ctx = createContext<CalibrationCtx | null>(null);

export function CalibrationProvider({ children }: { children: ReactNode }) {
  const [values, setValues] = useState<CalibrationValues>(CALIBRATION_EMPTY);
  const ctx = useMemo(() => ({ values, setValues }), [values]);
  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

export function useCalibration(): CalibrationCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCalibration must be used within CalibrationProvider");
  return ctx;
}
