"use client";

// 슬라이딩 필 인디케이터 세그먼트 토글 — 상단 파일/마이크 토글, 차트 L/R/Both 채널 토글이 공유한다.
// 항상 네이비 활성 배경("Split Studio" 목업의 톤) — 채널별 색으로 물들이지 않는다.
interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  options: SegmentedControlOption<T>[];
  onChange: (v: T) => void;
  size?: "md" | "sm";
  className?: string;
  "aria-label"?: string;
}

export default function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  size = "md",
  className,
  "aria-label": ariaLabel,
}: SegmentedControlProps<T>) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const pad = size === "sm" ? "p-0.5" : "p-1";
  const itemPad = size === "sm" ? "py-1" : "py-2";
  const textSize = size === "sm" ? "text-xs" : "text-sm";

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`relative flex ${pad} rounded-xl bg-iron-100 ${className ?? ""}`}
    >
      <span
        aria-hidden
        className="absolute top-0.5 bottom-0.5 rounded-lg bg-brand-blue shadow-[0_1px_3px_rgba(11,65,113,0.3)] transition-transform duration-[280ms] ease-[cubic-bezier(0.32,0.72,0,1)]"
        style={{
          left: "2px",
          width: `calc((100% - 4px) / ${options.length})`,
          transform: `translateX(${idx * 100}%)`,
        }}
      />
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={`relative z-10 flex-1 ${itemPad} ${textSize} font-semibold rounded-lg text-center transition-colors duration-200 ${
              active ? "text-white" : "text-iron-500 hover:text-iron-700"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
