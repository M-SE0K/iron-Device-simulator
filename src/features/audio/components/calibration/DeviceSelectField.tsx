"use client";

// Input/Output/Capture Device 3개 셀렉트가 공유하던 "저장된 장치가 현재 목록에 없으면
// (연결 해제) 값이 사라지지 않게 보존 표시"하는 옵션 구성 로직을 하나로 묶었다. 헤더 우측
// 버튼(새로고침 등)과 하단 안내 문구는 필드마다 달라 슬롯(headerRight/footnote)으로 남긴다.
import type { ReactNode } from "react";
import AnimatedSelect, { type SelectOption } from "@/shared/components/ui/AnimatedSelect";
import LabeledField from "@/shared/components/ui/LabeledField";

interface DeviceSelectFieldProps {
  label: string;
  "aria-label": string;
  value: string;
  onChange: (value: string) => void;
  /** 실제 장치 목록(플레이스홀더/저장-폴백 제외) — 컴포넌트가 앞뒤로 채운다 */
  devices: SelectOption[];
  /** value="" 일 때 보여줄 옵션 라벨 (예: "시스템 기본 입력") */
  placeholderLabel: string;
  /** 현재 value가 devices에 없을 때(연결 끊김) 폴백으로 쓸 라벨 */
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
    // 저장된 장치가 현재 목록에 없으면(연결 해제) 값이 사라지지 않게 보존 표시
    ...(value && !devices.some((d) => d.value === value)
      ? [{ value, label: savedLabel, hint: "연결 안 됨" }]
      : []),
  ];

  return (
    <LabeledField label={label} headerRight={headerRight} footnote={footnote}>
      <AnimatedSelect value={value} aria-label={ariaLabel} onChange={onChange} options={options} />
    </LabeledField>
  );
}
