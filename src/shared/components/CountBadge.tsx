// 섹션 헤더 우측의 "초록 점 + 개수(+접미사)" 배지 — WorkspaceFolderSection /
// RecordsDrawer / ChannelSelectDrawer 섹션 헤더가 공유한다.

interface CountBadgeProps {
  count: number;
  /** 개수 뒤 접미사(예: "개 파일", "ch") */
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
