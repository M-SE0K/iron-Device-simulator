"use client";

function formatLevel(v: number): string {
  return v > 0 && v < 1e-4 ? v.toExponential(1) : v.toFixed(4);
}

export function ChannelLevelBadge({ peak, rms }: { peak: number; rms: number }) {
  if (peak === 0) {
    return (
      <span
        className="ml-auto text-[10px] font-mono text-amber-600"
        title="This channel was exactly zero for the whole session — the sense input is most likely unconnected, or nothing was driving the output."
      >
        no signal (all zeros)
      </span>
    );
  }
  return (
    <span className="ml-auto text-[10px] font-mono text-iron-400">
      {`peak ${formatLevel(peak)} · rms ${formatLevel(rms)}`}
    </span>
  );
}
