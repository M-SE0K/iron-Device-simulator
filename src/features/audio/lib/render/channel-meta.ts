export interface ChannelRoleLabels {
  voltage: string;
  current: string;
  extended: string;
}

export function channelLabel(ch: number, roles: ChannelRoleLabels): { name: string; role: string } {
  if (ch === 0) return { name: "CH0", role: roles.voltage };
  if (ch === 1) return { name: "CH1", role: roles.current };
  return { name: `CH${ch}`, role: roles.extended };
}

const CHANNEL_COLORS = ["#0B4171", "#6B9BD1", "#10B981", "#F97316", "#0EA5E9", "#EC4899", "#84CC16", "#F43F5E"];

export function channelColor(ch: number): string {
  return CHANNEL_COLORS[ch % CHANNEL_COLORS.length];
}
