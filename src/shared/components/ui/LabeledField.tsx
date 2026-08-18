"use client";

import type { ReactNode } from "react";

interface LabeledFieldProps {
  label: string;
  headerRight?: ReactNode;
  footnote?: ReactNode;
  children: ReactNode;
}

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
