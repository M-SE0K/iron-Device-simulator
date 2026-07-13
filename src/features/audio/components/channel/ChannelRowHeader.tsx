// 채널 행 헤더 내용 — 색 점 + 채널명(mono) + 역할 + (있으면) peak·rms 배지.
// ChannelViewerOverlay(저장 세션 뷰)와 ChartDetailOverlay(라이브 스택 뷰)가 공유한다.
// 바깥 컨테이너(div/Fragment)는 호출부마다 달라 여기서는 내용(Fragment)만 그린다.

interface ChannelRowHeaderProps {
  color: string;
  name: string;
  role: string;
  /** peak/rms 통계 — 없으면(라이브 데이터 미도착 등) 배지를 숨긴다. */
  stats?: { peak: number; rms: number } | null;
}

export default function ChannelRowHeader({ color, name, role, stats }: ChannelRowHeaderProps) {
  return (
    <>
      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
      <span className="text-xs font-semibold text-iron-800 font-mono">{name}</span>
      <span className="text-[11px] text-iron-400">{role}</span>
      {stats && (
        <span className="ml-auto text-[10px] font-mono text-iron-400">
          peak {stats.peak.toFixed(4)} · rms {stats.rms.toFixed(4)}
        </span>
      )}
    </>
  );
}
