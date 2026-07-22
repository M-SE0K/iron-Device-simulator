interface ChannelRowHeaderProps {
  color: string;
  name: string;
  role: string;
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
