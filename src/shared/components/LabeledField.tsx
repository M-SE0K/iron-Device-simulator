"use client";

import type { ReactNode } from "react";

interface LabeledFieldProps {
  label: string;
  /** 라벨 우측 슬롯(새로고침 버튼 등) — 있으면 라벨과 justify-between 한 줄로 */
  headerRight?: ReactNode;
  /** 컨트롤 아래 안내 문구 슬롯 */
  footnote?: ReactNode;
  children: ReactNode;
}

/**
 * 캘리브레이션 폼의 "라벨 + 컨트롤" 공용 레이아웃 — SelectField/NumberField/DeviceSelectField가
 * 복붙하던 `flex flex-col gap-1.5` 래퍼와 `text-[10px] uppercase …` 라벨을 하나로 묶는다.
 * 실제 컨트롤(AnimatedSelect, number input 등)은 children으로 받는다.
 */
export default function LabeledField({ label, headerRight, footnote, children }: LabeledFieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {headerRight ? (
        <div className="flex items-center justify-between">
          <label className="text-[10px] uppercase tracking-wider font-medium text-iron-400">{label}</label>
          {headerRight}
        </div>
      ) : (
        <label className="text-[10px] uppercase tracking-wider font-medium text-iron-400">{label}</label>
      )}
      {children}
      {footnote}
    </div>
  );
}
