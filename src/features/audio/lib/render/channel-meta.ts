export function channelLabel(ch: number): { name: string; role: string } {
  if (ch === 0) return { name: "CH0", role: "V (전압)" };
  if (ch === 1) return { name: "CH1", role: "I (전류)" };
  return { name: `CH${ch}`, role: "확장" };
}

const CHANNEL_COLORS = ["#0B4171", "#6B9BD1", "#10B981", "#F97316", "#0EA5E9", "#EC4899", "#84CC16", "#F43F5E"];

export function channelColor(ch: number): string {
  return CHANNEL_COLORS[ch % CHANNEL_COLORS.length];
}
