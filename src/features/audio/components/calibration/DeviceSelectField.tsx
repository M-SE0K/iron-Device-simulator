"use client";

import type { ReactNode } from "react";
import AnimatedSelect, { type SelectOption } from "@/shared/components/ui/AnimatedSelect";
import LabeledField from "@/shared/components/ui/LabeledField";

interface DeviceSelectFieldProps {
  label: string;
  "aria-label": string;
  value: string;
  onChange: (value: string) => void;
  devices: SelectOption[];
  placeholderLabel: string;
  savedLabel: string;
  headerRight?: ReactNode;
  footnote?: ReactNode;
}

export default function DeviceSelectField({
  label,
  "aria-label": ariaLabel,
  value,
  onChange,
  devices,
  placeholderLabel,
  savedLabel,
  headerRight,
  footnote,
}: DeviceSelectFieldProps) {
  const options: SelectOption[] = [
    { value: "", label: placeholderLabel },
    ...devices,
    ...(value && !devices.some((d) => d.value === value)
      ? [{ value, label: savedLabel, hint: "Not Connected" }]
      : []),
  ];

  return (
    <LabeledField label={label} headerRight={headerRight} footnote={footnote}>
      <AnimatedSelect value={value} aria-label={ariaLabel} onChange={onChange} options={options} />
    </LabeledField>
  );
}
