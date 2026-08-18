interface CountBadgeProps {
  count: number;
  suffix?: string;
}

export default function CountBadge({ count, suffix }: CountBadgeProps) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-iron-400 tabular-nums">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
      {count}
      {suffix}
    </span>
  );
}
